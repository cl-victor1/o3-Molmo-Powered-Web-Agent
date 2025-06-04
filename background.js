// Helper function to strip JavaScript-style comments from JSON
function stripJsonComments(jsonString) {
  // Remove single-line comments (// ...)
  jsonString = jsonString.replace(/\/\/.*$/gm, '');
  
  // Remove multi-line comments (/* ... */)
  jsonString = jsonString.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Clean up any extra whitespace or commas that might be left behind
  jsonString = jsonString.replace(/,\s*([}\]])/g, '$1'); // Remove trailing commas
  jsonString = jsonString.replace(/\s+/g, ' ').trim(); // Normalize whitespace
  
  return jsonString;
}

// Initialize context for maintaining conversation history
let conversationHistory = [];

// Map to store tab-specific information
const tabContext = new Map();

// Map to track ongoing task executions
const taskExecutions = new Map();

// Regular OpenAI API Configuration
const OPENAI_API_ENDPOINT = "https://api.openai.com/v1";
const OPENAI_API_KEY = "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"; // Set your OpenAI API key here
const OPENAI_MODEL = "o3"; // Using o3-mini model (same as Azure deployment)
const GPT41_MODEL = "gpt-4.1"; // GPT-4 Turbo for text analysis and understanding

// Molmo API Configuration
const MOLMO_API_URL = "http://localhost:8000/molmo/point"; // SSH tunnel to Hyak Molmo service
const MOLMO_OFFICIAL_API_URL = "https://ai2-reviz--uber-model-v4-synthetic.modal.run/completion_stream"; // Official Molmo API
const MOLMO_API_KEY = "OYJnOH/zlDPN0DLq"; // Hardcoded Molmo API key

// Molmo API selection: 'local' or 'official'
let MOLMO_API_TYPE = 'official'; // Change to 'official' to use the official API

// Load saved configuration on startup (only for API type)
chrome.storage.sync.get(['molmo_api_type'], function(result) {
  if (result.molmo_api_type) {
    MOLMO_API_TYPE = result.molmo_api_type;
    console.log('Loaded Molmo API type from storage:', MOLMO_API_TYPE);
  }
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  
  // Handle command execution request from popup
  if (request.action === 'executeCommand') {
    const { command, apiKey, tabId, url, autoExecute } = request;
    
    // Store the context for this tab
    updateTabContext(tabId, url);
    
    // Check if there's already a task running for this tab
    if (taskExecutions.has(tabId)) {
      const status = taskExecutions.get(tabId);
      if (status.running) {
        sendResponse({ result: "A task is already running in this tab. Please wait for it to complete." });
        return true;
      }
    }
    
    // Start a new task execution and track it
    const taskStatus = { 
      running: true, 
      command,
      startTime: Date.now()
    };
    taskExecutions.set(tabId, taskStatus);
    
    // Set a global timeout for the task (5 minutes)
    const globalTimeout = setTimeout(() => {
      const currentStatus = taskExecutions.get(tabId);
      if (currentStatus && currentStatus.running) {
        console.log(`Task timeout reached for tab ${tabId}. Stopping task.`);
        currentStatus.running = false;
        currentStatus.stopped = true;
        currentStatus.error = 'Task timeout - execution stopped after 5 minutes';
        currentStatus.endTime = Date.now();
      }
    }, 300000); // 5 minutes
    
    taskStatus.globalTimeout = globalTimeout;
    
    // Process the command with OpenAI (use default API key if none provided)
    const taskPromise = processCommandWithOpenAI(command, apiKey, tabId, url, autoExecute);
    
    // For the popup, only wait a limited time for initial response
    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => {
        resolve({ result: "Task started and will continue running in the background. You can close this popup." });
      }, 5000); // Wait 5 seconds to see if we get a quick response
    });
    
    // Race between the actual completion and timeout for popup response
    Promise.race([taskPromise, timeoutPromise])
      .then(result => {
        sendResponse({ result });
      })
      .catch(error => {
        console.error('Error processing command:', error);
        sendResponse({ error: error.message || 'Failed to process command' });
      });
    
    // The full task will continue in the background
    taskPromise
      .then(result => {
        console.log('Task completed successfully:', result);
        const taskStatus = taskExecutions.get(tabId);
        if (taskStatus) {
          taskStatus.running = false;
          taskStatus.completed = true;
          taskStatus.result = result;
          taskStatus.endTime = Date.now();
          
          // Clear the global timeout
          if (taskStatus.globalTimeout) {
            clearTimeout(taskStatus.globalTimeout);
          }
        }
      })
      .catch(error => {
        console.error('Task failed:', error);
        const taskStatus = taskExecutions.get(tabId);
        if (taskStatus) {
          taskStatus.running = false;
          taskStatus.completed = false;
          taskStatus.error = error.message;
          taskStatus.endTime = Date.now();
          
          // Clear the global timeout
          if (taskStatus.globalTimeout) {
            clearTimeout(taskStatus.globalTimeout);
          }
        }
      });
    
    return true; // Indicates async response
  }
  
  // Handle request for task status
  if (request.action === 'getTaskStatus') {
    const { tabId } = request;
    const status = taskExecutions.get(tabId) || { running: false };
    sendResponse(status);
    return true;
  }
  
  // Handle request to stop/clear a running task
  if (request.action === 'stopTask') {
    const { tabId } = request;
    if (taskExecutions.has(tabId)) {
      const taskStatus = taskExecutions.get(tabId);
      taskStatus.running = false;
      taskStatus.stopped = true;
      taskStatus.endTime = Date.now();
      
      // Clear the global timeout
      if (taskStatus.globalTimeout) {
        clearTimeout(taskStatus.globalTimeout);
      }
      
      console.log(`Task stopped manually for tab ${tabId}`);
      sendResponse({ success: true, message: 'Task stopped successfully' });
    } else {
      sendResponse({ success: false, message: 'No running task found for this tab' });
    }
    return true;
  }
  
  // Handle result from content script after executing action
  if (request.action === 'actionResult') {
    const { success, result, error } = request;
    
    if (success) {
      console.log('Action executed successfully:', result);
    } else {
      console.error('Action execution failed:', error);
    }
    
    return false;
  }
  
  // Handle request for conversation history and context
  if (request.action === 'getConversationData') {
    const { tabId } = request;
    
    // Get tab-specific context
    const context = tabContext.get(tabId) || { url: '', lastResponse: null };
    
    // Send back conversation history and context
    sendResponse({
      conversationHistory: conversationHistory,
      lastResponse: context.lastResponse
    });
    
    return true;
  }
  
  // Handle setting API key
  if (request.action === 'setApiKey') {
    const { apiKey } = request;
    
    // Since we're using hardcoded OpenAI credentials, just acknowledge the request
    console.log('API key setting ignored - using hardcoded OpenAI credentials');
    sendResponse({ success: true });
    
    return true;
  }
  
  // Handle getting API key status
  if (request.action === 'getApiKeyStatus') {
    sendResponse({ 
      hasApiKey: !!OPENAI_API_KEY,
      apiKeySet: !!OPENAI_API_KEY
    });
    return true;
  }
  
  // Handle setting Molmo API type
  if (request.action === 'setMolmoApiType') {
    const { apiType } = request;
    
    // Store Molmo API type in Chrome storage
    chrome.storage.sync.set({ 'molmo_api_type': apiType }, function() {
      MOLMO_API_TYPE = apiType;
      console.log('Molmo API type saved to storage:', apiType);
      sendResponse({ success: true });
    });
    
    return true;
  }
  
  // Handle getting Molmo API type
  if (request.action === 'getMolmoApiType') {
    sendResponse({ 
      apiType: MOLMO_API_TYPE
    });
    return true;
  }
  
  // Handle getting enhanced NLP analysis for a tab
  if (request.action === 'getEnhancedAnalysis') {
    const { tabId } = request;
    const context = tabContext.get(tabId) || {};
    
    sendResponse({
      taskAnalysis: context.taskAnalysis || null,
      contentAnalysis: context.contentAnalysis || null,
      completionAnalysis: context.completionAnalysis || null,
      lastCommand: context.lastCommand || null,
      lastResponse: context.lastResponse || null
    });
    return true;
  }
  
  // Handle request to analyze current page with GPT-4.1
  if (request.action === 'analyzePageWithGPT41') {
    const { tabId, analysisType } = request;
    
    // Get enhanced page content
    chrome.scripting.executeScript({
      target: { tabId },
      function: getEnhancedPageContent
    }, async (result) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      
      if (result && result[0] && result[0].result) {
        const enhancedContent = result[0].result;
        const context = tabContext.get(tabId) || {};
        const lastCommand = context.lastCommand || 'General page analysis';
        
        try {
          const analysis = await analyzePageContentWithGPT41(enhancedContent, lastCommand, analysisType || 'general');
          sendResponse({ 
            success: true, 
            analysis,
            analysisType: analysisType || 'general'
          });
        } catch (error) {
          sendResponse({ 
            success: false, 
            error: error.message 
          });
        }
      } else {
        sendResponse({ 
          success: false, 
          error: 'Could not extract page content' 
        });
      }
    });
    
    return true; // Indicates async response
  }
  
  // Handle request to extract specific information with GPT-4.1
  if (request.action === 'extractInformationWithGPT41') {
    const { tabId, extractionTarget, context: extractionContext } = request;
    
    // Get enhanced page content
    chrome.scripting.executeScript({
      target: { tabId },
      function: getEnhancedPageContent
    }, async (result) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      
      if (result && result[0] && result[0].result) {
        const enhancedContent = result[0].result;
        
        try {
          const extractedInfo = await extractSpecificInformation(enhancedContent, extractionTarget, extractionContext || '');
          sendResponse({ 
            success: true, 
            extractedInfo,
            extractionTarget
          });
        } catch (error) {
          sendResponse({ 
            success: false, 
            error: error.message 
          });
        }
      } else {
        sendResponse({ 
          success: false, 
          error: 'Could not extract page content' 
        });
      }
    });
    
    return true; // Indicates async response
  }
  
  // Handle request to get page structure analysis
  if (request.action === 'getPageStructure') {
    const { tabId } = request;
    
    // Get both enhanced content and HTML structure
    Promise.all([
      chrome.scripting.executeScript({
        target: { tabId },
        function: getEnhancedPageContent
      }),
      chrome.scripting.executeScript({
        target: { tabId },
        function: getHTMLStructure
      })
    ]).then(([enhancedResult, structureResult]) => {
      const response = {
        success: true,
        enhancedContent: null,
        htmlStructure: null
      };
      
      if (enhancedResult && enhancedResult[0] && enhancedResult[0].result) {
        response.enhancedContent = enhancedResult[0].result;
      }
      
      if (structureResult && structureResult[0] && structureResult[0].result) {
        response.htmlStructure = structureResult[0].result;
      }
      
      sendResponse(response);
    }).catch(error => {
      sendResponse({ 
        success: false, 
        error: error.message 
      });
    });
    
    return true; // Indicates async response
  }
});

// Update context for specific tab
function updateTabContext(tabId, url) {
  if (!tabContext.has(tabId)) {
    tabContext.set(tabId, {
      url,
      pageContent: null,
      lastCommand: null,
      lastResponse: null
    });
    
    // Try to load previous command and response from storage
    chrome.storage.local.get([`tab_${tabId}_command`, `tab_${tabId}_response`], function(result) {
      const context = tabContext.get(tabId);
      if (result[`tab_${tabId}_command`]) {
        context.lastCommand = result[`tab_${tabId}_command`];
      }
      if (result[`tab_${tabId}_response`]) {
        context.lastResponse = result[`tab_${tabId}_response`];
      }
    });
  } else {
    const context = tabContext.get(tabId);
    context.url = url;
  }
}

// Process command with OpenAI API
async function processCommandWithOpenAI(command, apiKey, tabId, url, autoExecute) {
  try {
    // Get enhanced page content for better analysis
    let pageContent = '';
    let enhancedContent = null;
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // Check if the URL is accessible
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('edge://')) {
        console.log('Cannot access restricted URL for content extraction:', tab.url);
        pageContent = `Restricted URL: ${tab.url}`;
      } else {
        // Execute content script to get both basic and enhanced page information
        const [basicResult, enhancedResult] = await Promise.all([
          chrome.scripting.executeScript({
            target: { tabId },
            function: getPageContent
          }),
          chrome.scripting.executeScript({
            target: { tabId },
            function: getEnhancedPageContent
          })
        ]);
        
        // Extract content from script execution results
        if (basicResult && basicResult[0] && basicResult[0].result) {
          pageContent = basicResult[0].result;
        }
        
        if (enhancedResult && enhancedResult[0] && enhancedResult[0].result) {
          enhancedContent = enhancedResult[0].result;
          console.log('Enhanced content extracted:', enhancedContent);
        }
      }
    } catch (error) {
      console.error('Error getting page content:', error);
      // Continue with empty page content if there's an error
    }
    
    // Step 1: Analyze task requirements using GPT-4.1
    let taskAnalysis = null;
    if (enhancedContent) {
      try {
        console.log('Performing task analysis with GPT-4.1...');
        taskAnalysis = await analyzeTaskRequirements(command, enhancedContent);
        console.log('Task analysis completed:', taskAnalysis);
      } catch (error) {
        console.error('Error in task analysis:', error);
      }
    }
    
    // Step 2: Get content analysis using GPT-4.1 for better understanding
    let contentAnalysis = null;
    if (enhancedContent) {
      try {
        console.log('Performing content analysis with GPT-4.1...');
        contentAnalysis = await analyzePageContentWithGPT41(enhancedContent, command, 'task_understanding');
        console.log('Content analysis completed:', contentAnalysis);
      } catch (error) {
        console.error('Error in content analysis:', error);
      }
    }
    
    // Step 3: Prepare enhanced context for O3 model
    let enhancedContext = '';
    if (taskAnalysis) {
      enhancedContext += `\nTask Analysis: ${JSON.stringify(taskAnalysis)}\n`;
    }
    
    if (contentAnalysis) {
      enhancedContext += `\nContent Analysis: ${contentAnalysis}\n`;
    }
    
    if (enhancedContent) {
      enhancedContext += `\nEnhanced Page Summary: ${getEnhancedPageContentSummary(enhancedContent)}\n`;
    }
    
    // Update conversation history with enhanced context
    const contextualCommand = `${enhancedContext}
Current URL: ${url}
Page content summary: ${getPageContentSummary(pageContent)}

User command: ${command}`;
    
    conversationHistory.push({
      role: 'user',
      content: contextualCommand
    });
    
    // Make sure history doesn't get too long (keep last 10 messages)
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 10);
    }
    
    // Check if we have an API key
    const finalApiKey =  OPENAI_API_KEY; // use OpenAI for now
    if (!finalApiKey) {
      throw new Error('No OpenAI API key available. OpenAI credentials are hardcoded in the extension.');
    }
    
    // Step 4: Call O3 model for action generation with enhanced context
    console.log('Calling O3 model for action generation...');
    const response = await fetch(`${OPENAI_API_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalApiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are a helpful web browser assistant that can automate browsing tasks. 
                      You'll be given a user command and enhanced information about the current webpage including task analysis and content insights.
                      
                      ENHANCED CAPABILITIES:
                      - You now have detailed page structure analysis
                      - Task requirements have been pre-analyzed
                      - Content patterns have been identified
                      - Use this enhanced context to make better decisions
                      
                      Respond with specific actions to take, formatted as a JSON object.
                      
                      You can use these actions:
                      {"action": "click", "selector": "button.submit-btn"}
                      {"action": "click", "object_name": "search button"}
                      {"action": "type", "selector": "input#search", "text": "search query"}
                      {"action": "navigate", "url": "https://example.com"}
                      {"action": "extract", "selector": "div.results"}
                      {"action": "wait", "time": 2000}
                      {"action": "scroll", "direction": "down", "amount": 400}
                      
                      For the "click" action, you can use either:
                      1. CSS selector: {"action": "click", "selector": "button.submit-btn"}
                      2. Visual description: {"action": "click", "object_name": "search button"}
                      
                      When using object_name, provide a clear description of what to click on the screen. 
                      This uses the Molmo API to identify objects visually even without precise selectors.
                      
                      IMPORTANT SCROLLING GUIDELINES:
                      - The visual click system (object_name) automatically handles scrolling when elements are not found
                      - When using object_name clicks, the system will automatically scroll down multiple times to find the target
                      - You should focus on providing clear, descriptive object names rather than manual scrolling
                      - Only use manual scroll actions when you specifically need to navigate to a different part of the page
                      - For manual scrolling, use moderate amounts (200-400 pixels) to avoid overshooting
                      
                      VISUAL CLICK STRATEGY:
                      - The system will first try to find the element in the current viewport
                      - If not found, it will automatically scroll down in 300px increments up to 3 times
                      - If still not found, it will scroll back up to check if the element was above the original position
                      - This means you can confidently use object_name clicks without worrying about scrolling
                      
                      IMPORTANT: For YouTube videos, use specific descriptions like:
                      - "first video" or "first video thumbnail" for the first video in the list
                      - "second video" for the second video
                      - "video titled [title]" for a specific video by title
                      
                      ENHANCED DECISION MAKING:
                      - Use the task analysis to understand the complexity and approach needed
                      - Leverage content analysis to identify the most relevant page areas
                      - Consider the page structure and navigation patterns
                      - Make intelligent decisions about element targeting based on content insights
                      
                      If you need to perform multiple actions, return them as an array:
                      [{"action": "type", "selector": "input#search", "text": "cats"}, 
                       {"action": "click", "selector": "button.search-btn"}]
                      
                      For complex tasks that might require visual understanding:
                      [{"action": "type", "selector": "input#search", "text": "cats"},
                       {"action": "click", "object_name": "search button"}]
                      
                      For YouTube-specific tasks:
                      - To open the first video: {"action": "click", "object_name": "first video"}
                      - To open a specific video: {"action": "click", "object_name": "video titled [specific title]"}
                      
                      If you can't automate the task, explain why and provide guidance instead.`
          },
          ...conversationHistory
        ],
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'OpenAI API request failed');
    }
    
    const data = await response.json();
    const aiResponse = data.choices[0]?.message?.content || '';
    
    // Add AI response to conversation history
    conversationHistory.push({
      role: 'assistant',
      content: aiResponse
    });
    
    // Update tab context with latest response
    if (tabContext.has(tabId)) {
      const context = tabContext.get(tabId);
      context.lastCommand = command;
      context.lastResponse = aiResponse;
      context.taskAnalysis = taskAnalysis; // Store task analysis for later use
      context.contentAnalysis = contentAnalysis; // Store content analysis for later use
      
      // Save to persistent storage
      chrome.storage.local.set({
        [`tab_${tabId}_command`]: command,
        [`tab_${tabId}_response`]: aiResponse,
        [`tab_${tabId}_task_analysis`]: taskAnalysis,
        [`tab_${tabId}_content_analysis`]: contentAnalysis
      });
    }
    
    // Try to parse action from response
    let actions = null;
    try {
      console.log('AI Response received:', aiResponse);
      // Strip comments from response before parsing
      const cleanedResponse = stripJsonComments(aiResponse);
      console.log('Cleaned response for parsing:', cleanedResponse);
      
      // Try to parse the cleaned response as JSON directly
      actions = JSON.parse(cleanedResponse);
      console.log('Parsed actions:', actions);
    } catch (error) {
      // If direct parsing fails, try to find JSON within the response
      try {
        const jsonMatch = aiResponse.match(/(\{.*\}|\[.*\])/s);
        if (jsonMatch) {
          console.log('Attempting to parse JSON from match:', jsonMatch[0]);
          // Strip comments from the matched JSON as well
          const cleanedMatch = stripJsonComments(jsonMatch[0]);
          console.log('Cleaned matched JSON:', cleanedMatch);
          actions = JSON.parse(cleanedMatch);
          console.log('Parsed actions from match:', actions);
        } else {
          console.log('No JSON pattern found in AI response');
        }
      } catch (matchError) {
        console.log('Failed to parse JSON from response:', matchError.message);
      }
    }
    
    // If actions are parsed successfully, execute them
    if (actions) {
      console.log('Actions successfully parsed. AutoExecute mode:', autoExecute);
      if (autoExecute) {
        console.log('Auto-execute mode enabled, executing all actions:', actions);
        // Execute actions via content script and follow through to completion
        const executionResult = await executeActionsInTab(tabId, actions);
        return executionResult;
      } else {
        console.log('Manual mode, returning actions without execution');
        // In manual mode, just return the response with the actions
        return aiResponse;
      }
    } else {
      console.log('No actions parsed from AI response, returning raw response');
      // If no actions could be parsed, just return the AI response
      return aiResponse;
    }
  } catch (error) {
    console.error('Error processing with OpenAI:', error);
    throw error;
  }
}

// Function to execute actions in a tab via content script
async function executeActionsInTab(tabId, actions) {
  return await executeActionsInTabWithDepth(tabId, actions, 0);
}

// Function to execute actions in a tab via content script with recursion depth tracking
async function executeActionsInTabWithDepth(tabId, actions, recursionDepth = 0) {
  // If actions is not an array, make it one
  if (!Array.isArray(actions)) {
    actions = [actions];
  }
  
  try {
    // Execute each action in sequence
    for (let i = 0; i < actions.length; i++) {
      // Check if task has been stopped
      const taskStatus = taskExecutions.get(tabId);
      if (taskStatus && taskStatus.stopped) {
        console.log('Task execution stopped by user request');
        return 'Task execution stopped by user request';
      }
      
      const action = actions[i];
      console.log(`Executing action ${i+1}/${actions.length} (depth ${recursionDepth}):`, action);
      
      // Handle click action (both selector-based and visual object-based)
      if (action.action === 'click') {
        // Check if this is a visual click (object_name) or selector-based click
        if (action.object_name) {
          // Visual click using Molmo API
          try {
            console.log(`Starting visual click action for object: "${action.object_name}"`);
            
            // Check if we can access this tab first
            const tab = await new Promise((resolve, reject) => {
              chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(`Cannot access tab: ${chrome.runtime.lastError.message}`));
                } else {
                  resolve(tab);
                }
              });
            });
            
            // Check if the URL is accessible
            if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('edge://')) {
              throw new Error(`Cannot perform visual click on restricted URL: ${tab.url}. Please navigate to a regular webpage first.`);
            }
            
            // Capture screenshot
            console.log('Capturing screenshot...');
            const dataUrl = await captureScreenshot(tabId);
            
            // Convert data URL to base64
            const base64Image = dataUrl.split(',')[1];
            console.log('Screenshot captured successfully, size:', base64Image.length);
            
            // Get viewport dimensions for coordinate denormalization
            const viewportDimensions = await getViewportDimensions(tabId);
            console.log('Viewport dimensions:', viewportDimensions);
            
            // Format the object name as required by Molmo
            const formattedObjectName = `pointing: Point to ${action.object_name}`;
            
            console.log(`Calling Molmo API to locate: "${action.object_name}" with prompt: "${formattedObjectName}"`);
            
            // Add special handling for YouTube video elements
            if (tab.url.includes('youtube.com') && action.object_name.includes('video')) {
              console.log('YouTube context detected - optimizing for video element detection');
            }
            
            // Call Molmo API to get points
            console.log('About to call Molmo API...');
            const molmoResponse = await callMolmoAPI(base64Image, formattedObjectName);
            console.log('=== MOLMO API RESPONSE DEBUG ===');
            console.log('Raw Molmo response:', JSON.stringify(molmoResponse, null, 2));
            console.log('Response type:', typeof molmoResponse);
            console.log('Is array:', Array.isArray(molmoResponse));
            console.log('Response length:', molmoResponse ? molmoResponse.length : 'null/undefined');
            console.log('=== END MOLMO DEBUG ===');
            
            // Collect debug info to include in response
            const debugInfo = {
              molmoResponse: molmoResponse,
              responseType: typeof molmoResponse,
              isArray: Array.isArray(molmoResponse),
              responseLength: molmoResponse ? molmoResponse.length : 'null/undefined',
              apiType: MOLMO_API_TYPE,
              objectName: action.object_name
            };
            
            let points = molmoResponse;
            console.log('Molmo API call completed, received points:', points);
            
            // If no points found, try scrolling and retrying multiple times
            if (!points || points.length === 0) {
              console.log('No points found in initial screenshot, trying multiple scroll attempts...');
              
              const MAX_SCROLL_ATTEMPTS = 20;
              let scrollAttempt = 0;
              
              while (scrollAttempt < MAX_SCROLL_ATTEMPTS && (!points || points.length === 0)) {
                scrollAttempt++;
                console.log(`Scroll attempt ${scrollAttempt}/${MAX_SCROLL_ATTEMPTS}: scrolling down to find "${action.object_name}"`);
                
                // Perform a scroll down (300 pixels each time)
                await chrome.scripting.executeScript({
                  target: { tabId },
                  function: () => {
                    window.scrollBy(0, 300);
                    return `Scrolled down 300px (attempt ${arguments[0]})`;
                  },
                  args: [scrollAttempt]
                });
                
                // Wait for scroll to complete and page to settle
                await new Promise(resolve => setTimeout(resolve, 1500));
                
                // Capture new screenshot
                console.log(`Capturing screenshot after scroll attempt ${scrollAttempt}...`);
                const newDataUrl = await captureScreenshot(tabId);
                const newBase64Image = newDataUrl.split(',')[1];
                
                // Try Molmo API again
                console.log(`Retrying Molmo API after scroll attempt ${scrollAttempt}...`);
                const retryMolmoResponse = await callMolmoAPI(newBase64Image, formattedObjectName);
                
                if (retryMolmoResponse && retryMolmoResponse.length > 0) {
                  console.log(`Found points after scroll attempt ${scrollAttempt}:`, retryMolmoResponse);
                  // Use the retry response
                  Object.assign(debugInfo, {
                    retryAfterScroll: true,
                    scrollAttempts: scrollAttempt,
                    retryMolmoResponse: retryMolmoResponse
                  });
                  points = retryMolmoResponse;
                  break; // Exit the loop since we found points
                } else {
                  console.log(`Still no points found after scroll attempt ${scrollAttempt}`);
                }
              }
              
              // If still no points found after all scroll attempts, try scrolling up to check if we went too far
              if (!points || points.length === 0) {
                console.log('No points found after scrolling down, trying to scroll back up...');
                
                // Scroll back up to original position plus a bit more
                await chrome.scripting.executeScript({
                  target: { tabId },
                  function: () => {
                    window.scrollBy(0, -(300 * arguments[0] + 200)); // Scroll back up past original position
                    return `Scrolled back up ${300 * arguments[0] + 200}px`;
                  },
                  args: [scrollAttempt]
                });
                
                // Wait for scroll to complete
                await new Promise(resolve => setTimeout(resolve, 1500));
                
                // Try one more time
                console.log('Capturing screenshot after scrolling back up...');
                const finalDataUrl = await captureScreenshot(tabId);
                const finalBase64Image = finalDataUrl.split(',')[1];
                
                console.log('Final retry of Molmo API after scrolling back up...');
                const finalMolmoResponse = await callMolmoAPI(finalBase64Image, formattedObjectName);
                
                if (finalMolmoResponse && finalMolmoResponse.length > 0) {
                  console.log('Found points after scrolling back up:', finalMolmoResponse);
                  Object.assign(debugInfo, {
                    retryAfterScroll: true,
                    scrollAttempts: scrollAttempt,
                    finalRetryAfterScrollUp: true,
                    finalMolmoResponse: finalMolmoResponse
                  });
                  points = finalMolmoResponse;
                } else {
                  console.log('Still no points found after scrolling back up');
                }
              }
            }
            
            if (points && points.length > 0) {
              // Use the first point returned by Molmo
              const point = points[0];
              console.log(`Molmo found point:`, point);
              
              // Extract coordinates following the reference pattern
              let clickX, clickY;
              
              if (point.point && Array.isArray(point.point)) {
                // If point is in the format {point: [x, y]}
                clickX = parseFloat(point.point[0]);
                clickY = parseFloat(point.point[1]);
              } else if (point.x !== undefined && point.y !== undefined) {
                // If point is in the format {x: value, y: value}
                clickX = parseFloat(point.x);
                clickY = parseFloat(point.y);
              } else {
                throw new Error('Invalid point format from Molmo API');
              }
              
              // Check if we're using the official API and need to denormalize coordinates
              if (MOLMO_API_TYPE === 'official') {
                console.log(`Original coordinates from official API: (${clickX}, ${clickY})`);
                // Official API returns normalized coordinates that need to be denormalized
                // Divide by 100, then multiply by actual image dimensions
                clickX = (clickX / 100) * viewportDimensions.width;
                clickY = (clickY / 100) * viewportDimensions.height;
                console.log(`Denormalized coordinates: (${clickX}, ${clickY})`);
              }
              
              // Validate coordinates - ensure they are valid numbers
              if (isNaN(clickX) || isNaN(clickY)) {
                throw new Error(`Invalid coordinates from Molmo API: (${clickX}, ${clickY})`);
              }
              
              // If coordinates appear to be normalized (0-100), we might need to scale them
              // For now, just ensure they're positive and reasonable
              if (clickX < 0 || clickY < 0 || clickX > 10000 || clickY > 10000) {
                throw new Error(`Coordinates out of reasonable range: (${clickX}, ${clickY})`);
              }
              
              console.log(`Using validated coordinates: (${clickX}, ${clickY})`);
              
              // Execute click at the coordinates
              console.log(`Executing click at (${clickX}, ${clickY})`);
              const clickResult = await chrome.scripting.executeScript({
                target: { tabId },
                function: (x, y) => {
                  // Create and dispatch a click event at the specified coordinates
                  const clickEvent = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                  });
                  
                  // Find the element at the position and click it
                  const element = document.elementFromPoint(x, y);
                  if (element) {
                    console.log('Found element to click:', element.tagName, element.id || '', element.className || '');
                    element.dispatchEvent(clickEvent);
                    return { success: true, element: element.tagName };
                  }
                  return { success: false, element: null };
                },
                args: [clickX, clickY]
              });
              
              if (clickResult && clickResult[0] && clickResult[0].result && clickResult[0].result.success) {
                console.log(`Successfully clicked on ${clickResult[0].result.element} element`);
              } else {
                console.warn('Click dispatched, but no element was found at the coordinates');
              }
              
              // Wait a short time after clicking
              console.log('Waiting after click...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              console.log('Wait complete');
            } else {
              console.error('No points returned from Molmo API');
              const errorMsg = `Failed to locate "${action.object_name}" on screen. Debug info: ${JSON.stringify(debugInfo)}`;
              throw new Error(errorMsg);
            }
          } catch (error) {
            console.error('Error with visual click action:', error);
            throw error;
          }
        } else if (action.selector) {
          // Traditional selector-based click - send to content script
          await new Promise((resolve, reject) => {
            // First check if we can access this tab
            chrome.tabs.get(tabId, (tab) => {
              if (chrome.runtime.lastError) {
                reject(new Error(`Cannot access tab: ${chrome.runtime.lastError.message}`));
                return;
              }
              
              // Check if the URL is accessible
              if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('edge://')) {
                reject(new Error(`Cannot execute actions on restricted URL: ${tab.url}. Please navigate to a regular webpage first.`));
                return;
              }
              
              // Use a try-catch block to handle potential errors with chrome.tabs.sendMessage
              try {
                chrome.tabs.sendMessage(tabId, {
                  action: 'executeActions',
                  actions: [action]  // Send as array with single action
                }, response => {
                  // Check for runtime error first
                  if (chrome.runtime.lastError) {
                    console.log('Content script not ready, injecting it first:', chrome.runtime.lastError);
                    // If content script is not loaded, inject it first
                    chrome.scripting.executeScript({
                      target: { tabId },
                      files: ['content.js']
                    }, () => {
                      // Check for injection errors
                      if (chrome.runtime.lastError) {
                        console.error('Failed to inject content script:', chrome.runtime.lastError);
                        reject(chrome.runtime.lastError);
                        return;
                      }
                      
                      // Retry sending the message after script is injected
                      setTimeout(() => {
                        chrome.tabs.sendMessage(tabId, {
                          action: 'executeActions',
                          actions: [action]
                        }, secondResponse => {
                          if (chrome.runtime.lastError) {
                            console.error('Error in second attempt:', chrome.runtime.lastError);
                            reject(chrome.runtime.lastError);
                          } else if (secondResponse && secondResponse.success) {
                            resolve(secondResponse);
                          } else {
                            reject(new Error(`Failed to execute action: ${action.action}`));
                          }
                        });
                      }, 500);
                    });
                  } else if (response && response.success) {
                    resolve(response);
                  } else {
                    reject(new Error(`Failed to execute action: ${action.action}`));
                  }
                });
              } catch (error) {
                console.error('Error sending message to tab:', error);
                reject(error);
              }
            });
          });
        } else {
          throw new Error('Click action must have either "selector" or "object_name" property');
        }
        
        // Wait a short time after click action
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        // For non-click actions, send to content script
        await new Promise((resolve, reject) => {
          // First check if we can access this tab
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) {
              reject(new Error(`Cannot access tab: ${chrome.runtime.lastError.message}`));
              return;
            }
            
            // Check if the URL is accessible
            if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('edge://')) {
              reject(new Error(`Cannot execute actions on restricted URL: ${tab.url}. Please navigate to a regular webpage first.`));
              return;
            }
            
            // Use a try-catch block to handle potential errors with chrome.tabs.sendMessage
            try {
              chrome.tabs.sendMessage(tabId, {
                action: 'executeActions',
                actions: [action]  // Send as array with single action
              }, response => {
                // Check for runtime error first
                if (chrome.runtime.lastError) {
                  console.log('Content script not ready, injecting it first:', chrome.runtime.lastError);
                  // If content script is not loaded, inject it first
                  chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content.js']
                  }, () => {
                    // Check for injection errors
                    if (chrome.runtime.lastError) {
                      console.error('Failed to inject content script:', chrome.runtime.lastError);
                      reject(chrome.runtime.lastError);
                      return;
                    }
                    
                    // Retry sending the message after script is injected
                    setTimeout(() => {
                      chrome.tabs.sendMessage(tabId, {
                        action: 'executeActions',
                        actions: [action]
                      }, secondResponse => {
                        if (chrome.runtime.lastError) {
                          console.error('Error in second attempt:', chrome.runtime.lastError);
                          reject(chrome.runtime.lastError);
                        } else if (secondResponse && secondResponse.success) {
                          resolve(secondResponse);
                        } else {
                          reject(new Error(`Failed to execute action: ${action.action}`));
                        }
                      });
                    }, 500);
                  });
                } else if (response && response.success) {
                  resolve(response);
                } else {
                  reject(new Error(`Failed to execute action: ${action.action}`));
                }
              });
            } catch (error) {
              console.error('Error sending message to tab:', error);
              reject(error);
            }
          });
        });
        
        // Wait a short time between actions
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // After executing all actions, analyze the page to check task completion
    return await analyzePageAndContinue(tabId, recursionDepth);
    
  } catch (error) {
    console.error('Error executing actions:', error);
    throw error;
  }
}

// Function to analyze the current page and determine if task is complete
async function analyzePageAndContinue(tabId, recursionDepth = 0) {
  const MAX_RECURSION_DEPTH = 10; // Prevent infinite loops
  
  try {
    // Check if task has been stopped
    const taskStatus = taskExecutions.get(tabId);
    if (taskStatus && taskStatus.stopped) {
      console.log('Task analysis stopped by user request');
      return 'Task analysis stopped by user request';
    }
    
    // Check recursion depth to prevent infinite loops
    if (recursionDepth >= MAX_RECURSION_DEPTH) {
      console.log(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) reached. Stopping task execution.`);
      return "Task execution stopped after maximum attempts. The task may be complete or require manual intervention.";
    }
    
    // Get the current tab URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab.url;
    
    // Get enhanced page content for better analysis
    let pageContent = '';
    let enhancedContent = null;
    
    try {
      // Execute content scripts to get both basic and enhanced page information
      const [basicResult, enhancedResult] = await Promise.all([
        chrome.scripting.executeScript({
          target: { tabId },
          function: getPageContent
        }),
        chrome.scripting.executeScript({
          target: { tabId },
          function: getEnhancedPageContent
        })
      ]);
      
      // Extract content from script execution results
      if (basicResult && basicResult[0] && basicResult[0].result) {
        pageContent = basicResult[0].result;
      }
      
      if (enhancedResult && enhancedResult[0] && enhancedResult[0].result) {
        enhancedContent = enhancedResult[0].result;
      }
    } catch (error) {
      console.error('Error getting page content:', error);
      return "Task execution completed, but couldn't analyze the page content.";
    }
    
    // Get context for this tab
    const context = tabContext.get(tabId) || { lastCommand: '' };
    const lastCommand = context.lastCommand || '';
    const taskAnalysis = context.taskAnalysis || null;
    
    // Step 1: Use GPT-4.1 to analyze task completion with enhanced understanding
    let completionAnalysis = null;
    if (enhancedContent && lastCommand) {
      try {
        console.log('Analyzing task completion with GPT-4.1...');
        
        const systemPrompt = `You are an expert task completion analyst for web automation.
                              Analyze the current page state and determine if the user's task has been completed successfully.
                              
                              Consider:
                              1. The original task requirements and constraints
                              2. Current page content and structure
                              3. Evidence of successful task completion
                              4. Any error messages or failure indicators
                              5. Page changes that indicate progress or completion
                              
                              Provide your analysis in a structured JSON format:
                              {
                                "taskCompleted": true/false,
                                "confidence": "high/medium/low",
                                "reasoning": "explanation of your analysis",
                                "evidence": ["list of evidence supporting your conclusion"],
                                "nextSteps": "what should happen next",
                                "requiresAction": true/false,
                                "suggestedActions": ["list of actions if more work is needed"]
                              }`;
        
        let userPrompt = `Original Task: "${lastCommand}"
                         Current URL: ${url}
                         Enhanced Page Content: ${JSON.stringify(enhancedContent, null, 2)}`;
        
        if (taskAnalysis) {
          userPrompt += `\nOriginal Task Analysis: ${JSON.stringify(taskAnalysis)}`;
        }
        
        userPrompt += '\n\nPlease analyze if the task has been completed and provide structured insights.';
        
        const response = await fetch(`${OPENAI_API_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: GPT41_MODEL,
            messages: [
              {
                role: 'system',
                content: systemPrompt
              },
              {
                role: 'user',
                content: userPrompt
              }
            ],
            max_tokens: 1000,
            temperature: 0.1
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          const analysis = data.choices[0]?.message?.content || '';
          
          try {
            completionAnalysis = JSON.parse(analysis);
            console.log('GPT-4.1 completion analysis:', completionAnalysis);
          } catch (parseError) {
            console.log('Could not parse completion analysis as JSON, using as text');
            completionAnalysis = { analysis: analysis, parseError: true };
          }
        }
      } catch (error) {
        console.error('Error in GPT-4.1 completion analysis:', error);
      }
    }
    
    // Step 2: If GPT-4.1 indicates task is complete, return success
    if (completionAnalysis && completionAnalysis.taskCompleted === true) {
      const confidence = completionAnalysis.confidence || 'medium';
      const reasoning = completionAnalysis.reasoning || 'Task appears to be completed based on page analysis';
      
      console.log(`Task marked as completed by GPT-4.1 with ${confidence} confidence: ${reasoning}`);
      return `TASK_COMPLETED: ${reasoning}. Evidence: ${(completionAnalysis.evidence || []).join(', ')}`;
    }
    
    // Step 3: If GPT-4.1 indicates more actions are needed, continue with O3 model
    if (completionAnalysis && completionAnalysis.requiresAction === true && completionAnalysis.suggestedActions) {
      console.log('GPT-4.1 suggests continuing with additional actions:', completionAnalysis.suggestedActions);
      
      // Execute the suggested actions with recursion tracking
      await executeActionsInTabWithDepth(tabId, completionAnalysis.suggestedActions, recursionDepth + 1);
      return `Task continuation based on GPT-4.1 analysis: ${completionAnalysis.reasoning}`;
    }
    
    // Step 4: Fallback to O3 model for action planning if GPT-4.1 analysis is unclear
    console.log('Using O3 model for task completion analysis and action planning...');
    
    // Update conversation history with current page state
    const contextualPrompt = `Current URL: ${url}
Page content summary: ${getPageContentSummary(pageContent)}
Enhanced page summary: ${getEnhancedPageContentSummary(enhancedContent)}

Is the task "${lastCommand}" completed? If not, what additional steps are needed?

${completionAnalysis ? `GPT-4.1 Analysis: ${JSON.stringify(completionAnalysis)}` : ''}`;
    
    conversationHistory.push({
      role: 'user',
      content: contextualPrompt
    });
    
    // Call O3 API to analyze task completion
    if (!OPENAI_API_KEY) {
      throw new Error('No OpenAI API key available for task analysis.');
    }
    
    const response = await fetch(`${OPENAI_API_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are a helpful web browser automation assistant with enhanced analysis capabilities.
                      Analyze the current page content and URL to determine if the user's task has been completed.
                      You now have access to both basic page content and enhanced page analysis including GPT-4.1 insights.
                      
                      If the task is complete, respond with "TASK_COMPLETED: " followed by a brief summary.
                      If the task is incomplete, respond with "TASK_INCOMPLETE: " followed by a JSON array of actions needed to complete the task.
                      
                      IMPORTANT: Be conservative about continuing tasks. If you're unsure or if the page seems to have changed appropriately, 
                      consider the task completed rather than continuing indefinitely.
                      
                      ENHANCED DECISION MAKING:
                      - Consider GPT-4.1 analysis insights when available
                      - Look for evidence of successful completion in page changes
                      - Use enhanced page structure understanding for better decisions
                      - Leverage task analysis insights for improved completion detection
                      
                      IMPORTANT SCROLLING GUIDELINES:
                      - The visual click system (object_name) automatically handles scrolling when elements are not found
                      - When using object_name clicks, the system will automatically scroll down multiple times to find the target
                      - You should focus on providing clear, descriptive object names rather than manual scrolling
                      - Only use manual scroll actions when you specifically need to navigate to a different part of the page
                      - For manual scrolling, use moderate amounts (200-400 pixels) to avoid overshooting
                      
                      VISUAL CLICK STRATEGY:
                      - The system will first try to find the element in the current viewport
                      - If not found, it will automatically scroll down in 300px increments up to 3 times
                      - If still not found, it will scroll back up to check if the element was above the original position
                      - This means you can confidently use object_name clicks without worrying about scrolling
                      
                      Use the following action formats:
                      {"action": "click", "selector": "button.submit-btn"}
                      {"action": "type", "selector": "input#search", "text": "search query"}
                      {"action": "navigate", "url": "https://example.com"}
                      {"action": "extract", "selector": "div.results"}
                      {"action": "wait", "time": 2000}
                      {"action": "scroll", "direction": "down", "amount": 400}
                      {"action": "click", "object_name": "search button"}`
          },
          ...conversationHistory
        ],
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'OpenAI API request failed');
    }
    
    const data = await response.json();
    const aiResponse = data.choices[0]?.message?.content || '';
    
    // Add AI response to conversation history
    conversationHistory.push({
      role: 'assistant',
      content: aiResponse
    });
    
    // Update tab context with latest response
    if (tabContext.has(tabId)) {
      const context = tabContext.get(tabId);
      context.lastResponse = aiResponse;
      context.completionAnalysis = completionAnalysis; // Store GPT-4.1 analysis
      
      // Save to persistent storage
      chrome.storage.local.set({
        [`tab_${tabId}_response`]: aiResponse,
        [`tab_${tabId}_completion_analysis`]: completionAnalysis
      });
    }
    
    // Check if task is complete or needs additional actions
    if (aiResponse.startsWith('TASK_COMPLETED:')) {
      return aiResponse;
    } else if (aiResponse.startsWith('TASK_INCOMPLETE:')) {
      try {
        // Extract the JSON array of actions
        const actionsMatch = aiResponse.match(/(\[.*\])/s);
        if (actionsMatch) {
          const nextActions = JSON.parse(actionsMatch[0]);
          console.log(`Task incomplete (depth ${recursionDepth}), executing additional actions:`, nextActions);
          
          // Execute the next set of actions with recursion tracking
          await executeActionsInTabWithDepth(tabId, nextActions, recursionDepth + 1);
          return aiResponse;
        }
      } catch (error) {
        console.error('Error parsing next actions:', error);
      }
    }
    
    return aiResponse;
  } catch (error) {
    console.error('Error analyzing page:', error);
    return `Error analyzing page completion: ${error.message}`;
  }
}

// Function to capture screenshot of current tab
async function captureScreenshot(tabId) {
  return new Promise((resolve, reject) => {
    // First check if we can access this tab
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Cannot access tab: ${chrome.runtime.lastError.message}`));
        return;
      }
      
      // Check if the URL is a chrome:// URL or other restricted URL
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('edge://')) {
        reject(new Error(`Cannot capture screenshot of restricted URL: ${tab.url}`));
        return;
      }
      
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, dataUrl => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Screenshot capture failed: ${chrome.runtime.lastError.message}`));
        } else {
          resolve(dataUrl);
        }
      });
    });
  });
}

// Function to get viewport dimensions from the tab
async function getViewportDimensions(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      function: () => {
        return {
          width: window.innerWidth,
          height: window.innerHeight
        };
      }
    });
    
    if (result && result[0] && result[0].result) {
      return result[0].result;
    } else {
      throw new Error('Failed to get viewport dimensions');
    }
  } catch (error) {
    console.error('Error getting viewport dimensions:', error);
    // Fallback to common screen dimensions
    return { width: 1920, height: 1080 };
  }
}

// Function to call Official Molmo API (based on test_molmo_api.py)
async function callMolmoOfficialAPI(imageBase64, objectName) {
  const MAX_RETRIES = 2;
  let retryCount = 0;
  
  while (retryCount < MAX_RETRIES) {
    try {
      console.log(`Calling Official Molmo API with object name: ${objectName} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      // Prepare API request data following the official API format
      const requestData = {
        input_text: [`pointing: Point to ${objectName}`],
        input_image: [imageBase64]
      };
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Official Molmo API request timeout')), 60000) // Longer timeout for official API
      );
      
      // Create the fetch promise
      console.log(`Sending request to Official Molmo API at: ${MOLMO_OFFICIAL_API_URL}`);
      console.log('Request data:', { ...requestData, input_image: [`[${requestData.input_image[0].length} chars]`] });
      const fetchPromise = fetch(MOLMO_OFFICIAL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MOLMO_API_KEY}`
        },
        body: JSON.stringify(requestData)
      });
      
      // Race between fetch and timeout
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      
      // Check response status
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error calling Official Molmo API: ${response.status} - ${errorText}`);
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 1000 * retryCount; // Exponential backoff
          console.log(`Will retry in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return [];
      }
      
      // Parse the streaming response
      let responseText = '';
      
      // Handle streaming response (following test_molmo_api.py pattern)
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.result && parsed.result.output && parsed.result.output.text) {
                  responseText += parsed.result.output.text;
                }
              } catch (parseError) {
                // Ignore parsing errors for incomplete chunks
                console.debug('Ignoring incomplete chunk:', line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      
      console.log('Received full response from Official Molmo API:', responseText);
      console.log('=== OFFICIAL MOLMO API DEBUG ===');
      console.log('Raw response text length:', responseText.length);
      console.log('Raw response text content:', responseText);
      console.log('=== END OFFICIAL MOLMO DEBUG ===');
      
      // Parse coordinates from the response text
      // The response typically contains coordinate information
      const points = parseCoordinatesFromText(responseText);
      console.log('=== COORDINATE PARSING DEBUG ===');
      console.log('Parsed points from parseCoordinatesFromText:', JSON.stringify(points, null, 2));
      console.log('Number of parsed points:', points ? points.length : 'null/undefined');
      console.log('=== END COORDINATE PARSING DEBUG ===');
      
      if (points && points.length > 0) {
        console.log(`Official Molmo found ${points.length} points:`, points);
        return points;
      } else {
        console.error('No points found in Official Molmo API response');
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 1000 * retryCount; // Exponential backoff
          console.log(`Will retry in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return [];
      }
    } catch (error) {
      console.error('Error calling Official Molmo API:', error);
      
      // Increase retry count and try again after delay
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        const delay = 1000 * retryCount; // Exponential backoff
        console.log(`Will retry in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return [];
    }
  }
  
  // All retries failed
  console.error(`Failed to get a valid response from Official Molmo API after ${MAX_RETRIES} attempts`);
  return [];
}

// Helper function to parse coordinates from text response
function parseCoordinatesFromText(text) {
  const points = [];
  
  // Look for coordinate patterns in the text
  // This might need to be adjusted based on the actual response format from the official API
  const coordPatterns = [
    /\[(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\]/g, // [x, y] format
    /\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)/g, // (x, y) format
    /x[:\s]*(\d+(?:\.\d+)?)[,\s]+y[:\s]*(\d+(?:\.\d+)?)/gi, // x: 100, y: 200 format
    /<point\s+x\s*=\s*["\']?(\d+(?:\.\d+)?)["\']?\s+y\s*=\s*["\']?(\d+(?:\.\d+)?)["\']?[^>]*>/gi, // <point x="56.5" y="95.5"> XML format
  ];
  
  for (const pattern of coordPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const x = parseFloat(match[1]);
      const y = parseFloat(match[2]);
      
      if (!isNaN(x) && !isNaN(y)) {
        points.push({ point: [x, y] });
      }
    }
  }
  
  return points;
}

// Function to call Molmo API (router that chooses between local and official APIs)
async function callMolmoAPI(imageBase64, objectName) {
  // Force reload the latest configuration from storage before making API call
  await new Promise((resolve) => {
    chrome.storage.sync.get(['molmo_api_type'], function(result) {
      if (result.molmo_api_type) {
        MOLMO_API_TYPE = result.molmo_api_type;
        console.log('Reloaded Molmo API type from storage:', MOLMO_API_TYPE);
      } else {
        console.log('No molmo_api_type found in storage, using default:', MOLMO_API_TYPE);
      }
      resolve();
    });
  });
  
  console.log(`Using Molmo API type: ${MOLMO_API_TYPE}`);
  console.log(`Comparison check - is '${MOLMO_API_TYPE}' === 'official'?`, MOLMO_API_TYPE === 'official');
  
  if (MOLMO_API_TYPE === 'official') {
    console.log('Calling Official Molmo API');
    return await callMolmoOfficialAPI(imageBase64, objectName);
  } else {
    console.log('Calling Local Molmo API');
    return await callMolmoLocalAPI(imageBase64, objectName);
  }
}

// Function to call Local Molmo API (renamed from original callMolmoAPI)
async function callMolmoLocalAPI(imageBase64, objectName) {
  const MAX_RETRIES = 3;
  let retryCount = 0;
  
  while (retryCount < MAX_RETRIES) {
    try {
      console.log(`Calling Molmo API with object name: ${objectName} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      // Prepare API request data
      const requestData = {
        image_base64: imageBase64,
        object_name: objectName,
        model_name: "Molmo-7B-D-0924"
      };
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Molmo API request timeout')), 30000)
      );
      
      // Create the fetch promise
      console.log(`Sending request to Molmo API at: ${MOLMO_API_URL}`);
      console.log('Request data:', { ...requestData, image_base64: `[${requestData.image_base64.length} chars]` });
      const fetchPromise = fetch(`${MOLMO_API_URL}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });
      
      // Race between fetch and timeout
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      
      // Check response status
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error calling Molmo API: ${response.status} - ${errorText}`);
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 1000 * retryCount; // Exponential backoff
          console.log(`Will retry in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return [];
      }
      
      // Parse the response
      const result = await response.json();
      console.log('Received response from Molmo API:', result);
      console.log('=== LOCAL MOLMO API DEBUG ===');
      console.log('Full response structure:', JSON.stringify(result, null, 2));
      console.log('Response has error:', !!result.error);
      console.log('Response has points:', !!result.points);
      console.log('Points is array:', Array.isArray(result.points));
      console.log('Points length:', result.points ? result.points.length : 'null/undefined');
      if (result.points) {
        console.log('Raw points data:', JSON.stringify(result.points, null, 2));
      }
      console.log('=== END LOCAL MOLMO DEBUG ===');
      
      // Check for errors
      if (result.error) {
        console.error(`Error from Molmo API: ${result.error}`);
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 1000 * retryCount; // Exponential backoff
          console.log(`Will retry in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return [];
      }
      
      // Process and return the points
      if (result.points && result.points.length > 0) {
        console.log(`Molmo found ${result.points.length} points. Raw response:`, result.points);
        
        // Process points to ensure they're in a consistent, serializable format
        const processedPoints = result.points.map(point => {
          if (typeof point === 'object' && point !== null) {
            // Extract coordinates and ensure they're basic numbers
            let x, y;
            
            if (point.point && Array.isArray(point.point)) {
              x = parseFloat(point.point[0]);
              y = parseFloat(point.point[1]);
            } else if (point.x !== undefined && point.y !== undefined) {
              x = parseFloat(point.x);
              y = parseFloat(point.y);
            } else {
              console.warn('Skipping point with unknown format:', point);
              return null;
            }
            
            // Validate and return as simple object
            if (!isNaN(x) && !isNaN(y)) {
              return { point: [x, y] };
            }
          }
          return null;
        }).filter(point => point !== null);
        
        console.log(`Processed ${processedPoints.length} valid points:`, processedPoints);
        return processedPoints;
      } else {
        console.error('No points found in Molmo API response', result);
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 1000 * retryCount; // Exponential backoff
          console.log(`Will retry in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return [];
      }
    } catch (error) {
      console.error('Error calling Molmo API:', error);
      
      // Increase retry count and try again after delay
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        const delay = 1000 * retryCount; // Exponential backoff
        console.log(`Will retry in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return [];
    }
  }
  
  // All retries failed
  console.error(`Failed to get a valid response from Molmo API after ${MAX_RETRIES} attempts`);
  return [];
}

// Function to be injected into the page to get content
function getPageContent() {
  // Get page title
  const title = document.title;
  
  // Get meta description
  let description = '';
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) {
    description = metaDescription.getAttribute('content');
  }
  
  // Get main content text
  const bodyText = document.body.innerText.substring(0, 5000);
  
  // Get visible links
  const links = Array.from(document.querySelectorAll('a'))
    .filter(link => {
      const rect = link.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map(link => ({
      text: link.innerText.trim(),
      href: link.href
    }))
    .slice(0, 20);
  
  // Get form elements
  const forms = Array.from(document.querySelectorAll('form'))
    .map(form => {
      const inputs = Array.from(form.querySelectorAll('input, select, textarea'))
        .map(input => ({
          type: input.type || input.tagName.toLowerCase(),
          name: input.name,
          id: input.id,
          placeholder: input.placeholder
        }));
      
      return {
        id: form.id,
        action: form.action,
        inputs
      };
    });
  
  // Get buttons
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], .btn, input[type="submit"]'))
    .map(button => ({
      text: button.innerText.trim(),
      id: button.id,
      class: button.className
    }))
    .slice(0, 20);
  
  return {
    title,
    description,
    bodyText,
    links,
    forms,
    buttons
  };
}

// Enhanced function to get detailed page content including HTML structure
function getEnhancedPageContent() {
  // Get basic page information
  const title = document.title;
  const url = window.location.href;
  
  // Get meta information
  const metaInfo = {
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
    keywords: document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '',
    author: document.querySelector('meta[name="author"]')?.getAttribute('content') || ''
  };
  
  // Get page structure - headings hierarchy
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .map(heading => ({
      level: parseInt(heading.tagName.charAt(1)),
      text: heading.innerText.trim(),
      id: heading.id
    }))
    .slice(0, 20);
  
  // Get main content areas
  const mainContent = [];
  const contentSelectors = ['main', '[role="main"]', '.main-content', '.content', 'article', '.article'];
  for (const selector of contentSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      mainContent.push({
        selector,
        text: element.innerText.substring(0, 2000)
      });
      break; // Use the first found main content area
    }
  }
  
  // Get navigation elements
  const navigation = Array.from(document.querySelectorAll('nav, .nav, .navigation, [role="navigation"]'))
    .map(nav => ({
      text: nav.innerText.trim().substring(0, 500),
      links: Array.from(nav.querySelectorAll('a')).map(a => ({
        text: a.innerText.trim(),
        href: a.href
      })).slice(0, 10)
    }))
    .slice(0, 3);
  
  // Get interactive elements with better detail
  const interactiveElements = {
    buttons: Array.from(document.querySelectorAll('button, [role="button"], .btn, input[type="submit"], input[type="button"]'))
      .filter(btn => {
        const rect = btn.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(btn => ({
        text: btn.innerText.trim() || btn.value || btn.getAttribute('aria-label') || '',
        id: btn.id,
        className: btn.className,
        type: btn.type,
        disabled: btn.disabled
      }))
      .slice(0, 30),
    
    inputs: Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(input => {
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(input => ({
        type: input.type || input.tagName.toLowerCase(),
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        value: input.value,
        required: input.required,
        label: input.labels?.[0]?.innerText?.trim() || ''
      }))
      .slice(0, 20),
    
    links: Array.from(document.querySelectorAll('a[href]'))
      .filter(link => {
        const rect = link.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(link => ({
        text: link.innerText.trim(),
        href: link.href,
        title: link.title
      }))
      .slice(0, 30)
  };
  
  // Get specific content patterns (tables, lists, etc.)
  const structuredContent = {
    tables: Array.from(document.querySelectorAll('table'))
      .map(table => ({
        headers: Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim()),
        rowCount: table.querySelectorAll('tr').length,
        text: table.innerText.substring(0, 1000)
      }))
      .slice(0, 5),
    
    lists: Array.from(document.querySelectorAll('ul, ol'))
      .map(list => ({
        type: list.tagName.toLowerCase(),
        items: Array.from(list.querySelectorAll('li')).map(li => li.innerText.trim()).slice(0, 10),
        itemCount: list.querySelectorAll('li').length
      }))
      .slice(0, 10)
  };
  
  // Get text content in chunks for better analysis
  const textContent = {
    fullText: document.body.innerText.substring(0, 8000),
    paragraphs: Array.from(document.querySelectorAll('p'))
      .map(p => p.innerText.trim())
      .filter(text => text.length > 20)
      .slice(0, 15)
  };
  
  // Get error messages or alerts
  const alerts = Array.from(document.querySelectorAll('.alert, .error, .warning, .success, [role="alert"]'))
    .map(alert => ({
      text: alert.innerText.trim(),
      className: alert.className,
      type: alert.getAttribute('role') || 'unknown'
    }))
    .slice(0, 5);
  
  return {
    title,
    url,
    metaInfo,
    headings,
    mainContent,
    navigation,
    interactiveElements,
    structuredContent,
    textContent,
    alerts,
    timestamp: new Date().toISOString()
  };
}

// Function to extract HTML structure for analysis
function getHTMLStructure() {
  const structure = {
    // Document structure
    doctype: document.doctype ? document.doctype.name : 'unknown',
    htmlLang: document.documentElement.lang || 'not-specified',
    
    // Head information
    head: {
      title: document.title,
      metaTags: Array.from(document.querySelectorAll('meta')).map(meta => ({
        name: meta.name,
        property: meta.property,
        content: meta.content,
        httpEquiv: meta.httpEquiv
      })).slice(0, 20),
      stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(link => link.href).slice(0, 10),
      scripts: Array.from(document.querySelectorAll('script[src]')).map(script => script.src).slice(0, 10)
    },
    
    // Body structure
    body: {
      classes: document.body.className.split(' ').filter(c => c.trim()),
      id: document.body.id,
      dataAttributes: Object.fromEntries(
        Array.from(document.body.attributes)
          .filter(attr => attr.name.startsWith('data-'))
          .map(attr => [attr.name, attr.value])
      )
    },
    
    // Semantic structure
    semanticElements: {
      header: !!document.querySelector('header'),
      nav: !!document.querySelector('nav'),
      main: !!document.querySelector('main'),
      aside: !!document.querySelector('aside'),
      footer: !!document.querySelector('footer'),
      article: document.querySelectorAll('article').length,
      section: document.querySelectorAll('section').length
    },
    
    // Content statistics
    contentStats: {
      totalElements: document.querySelectorAll('*').length,
      textNodes: document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT).nextNode() ? 'present' : 'none',
      images: document.querySelectorAll('img').length,
      videos: document.querySelectorAll('video').length,
      iframes: document.querySelectorAll('iframe').length
    }
  };
  
  return structure;
}

// Helper function to get a text summary from page content
function getPageContentSummary(pageContent) {
  // If pageContent is null, undefined, or not an object
  if (!pageContent || typeof pageContent !== 'object') {
    return 'No page content available';
  }
  
  let summary = '';
  
  // Add title and description if available
  if (pageContent.title) {
    summary += `Title: ${pageContent.title}\n`;
  }
  
  if (pageContent.description) {
    summary += `Description: ${pageContent.description}\n`;
  }
  
  // Add body text excerpt if available
  if (pageContent.bodyText) {
    summary += `Content: ${pageContent.bodyText.substring(0, 300)}...\n`;
  }
  
  // Add some link info if available
  if (pageContent.links && pageContent.links.length > 0) {
    summary += `Links: ${pageContent.links.slice(0, 3).map(link => link.text || link.href).join(', ')}${pageContent.links.length > 3 ? '...' : ''}\n`;
  }
  
  return summary.trim() || 'No content details available';
}

// Enhanced function to get detailed summary from enhanced page content
function getEnhancedPageContentSummary(enhancedContent) {
  if (!enhancedContent || typeof enhancedContent !== 'object') {
    return 'No enhanced content available';
  }
  
  let summary = '';
  
  // Basic information
  if (enhancedContent.title) {
    summary += `Title: ${enhancedContent.title}\n`;
  }
  
  if (enhancedContent.url) {
    summary += `URL: ${enhancedContent.url}\n`;
  }
  
  // Meta information
  if (enhancedContent.metaInfo?.description) {
    summary += `Meta Description: ${enhancedContent.metaInfo.description}\n`;
  }
  
  // Page structure
  if (enhancedContent.headings && enhancedContent.headings.length > 0) {
    summary += `Headings: ${enhancedContent.headings.slice(0, 5).map(h => `H${h.level}: ${h.text}`).join(', ')}\n`;
  }
  
  // Main content
  if (enhancedContent.mainContent && enhancedContent.mainContent.length > 0) {
    summary += `Main Content: ${enhancedContent.mainContent[0].text.substring(0, 500)}...\n`;
  }
  
  // Interactive elements summary
  if (enhancedContent.interactiveElements) {
    const elements = enhancedContent.interactiveElements;
    if (elements.buttons?.length > 0) {
      summary += `Buttons: ${elements.buttons.slice(0, 5).map(b => b.text).filter(t => t).join(', ')}\n`;
    }
    if (elements.inputs?.length > 0) {
      summary += `Input Fields: ${elements.inputs.slice(0, 5).map(i => i.placeholder || i.label || i.type).filter(t => t).join(', ')}\n`;
    }
  }
  
  // Alerts or important messages
  if (enhancedContent.alerts && enhancedContent.alerts.length > 0) {
    summary += `Alerts: ${enhancedContent.alerts.map(a => a.text).join(', ')}\n`;
  }
  
  return summary.trim() || 'No enhanced content details available';
}

// Function to call GPT-4.1 for enhanced text analysis and understanding
async function analyzePageContentWithGPT41(enhancedContent, userCommand, analysisType = 'general') {
  try {
    console.log(`Calling GPT-4.1 for ${analysisType} analysis`);
    
    let systemPrompt = '';
    let userPrompt = '';
    
    switch (analysisType) {
      case 'task_understanding':
        systemPrompt = `You are an expert web automation assistant specializing in task understanding and content analysis.
                        Analyze the provided webpage content and user command to understand what specific actions are needed.
                        Focus on:
                        1. Identifying relevant content areas for the task
                        2. Understanding the context and website type
                        3. Recognizing patterns that indicate task completion
                        4. Suggesting specific elements to interact with
                        
                        Provide a structured analysis with:
                        - Task type classification
                        - Relevant content areas identified
                        - Key elements for interaction
                        - Success criteria for task completion`;
        
        userPrompt = `Webpage Content: ${JSON.stringify(enhancedContent, null, 2)}
                      
                      User Command: ${userCommand}
                      
                      Please analyze this webpage content and provide insights for completing the user's task.`;
        break;
        
      case 'content_extraction':
        systemPrompt = `You are an expert at extracting and interpreting structured information from web pages.
                        Analyze the provided webpage content to extract key information that would be relevant for automation tasks.
                        Focus on:
                        1. Identifying important data patterns (prices, ratings, names, etc.)
                        2. Understanding content hierarchy and relationships
                        3. Recognizing form structures and input requirements
                        4. Extracting relevant text and numerical data
                        
                        Provide structured extraction results with clear categorization.`;
        
        userPrompt = `Webpage Content: ${JSON.stringify(enhancedContent, null, 2)}
                      
                      User Command: ${userCommand}
                      
                      Please extract and structure the most relevant information from this webpage for the given task.`;
        break;
        
      case 'action_planning':
        systemPrompt = `You are an expert web automation strategist specializing in action sequence planning.
                        Analyze the webpage content and user command to create an optimal action plan.
                        Focus on:
                        1. Breaking down complex tasks into simple steps
                        2. Identifying the correct sequence of interactions
                        3. Anticipating potential obstacles or edge cases
                        4. Providing fallback strategies
                        
                        Create a detailed step-by-step plan with specific element targeting strategies.`;
        
        userPrompt = `Webpage Content: ${JSON.stringify(enhancedContent, null, 2)}
                      
                      User Command: ${userCommand}
                      
                      Please create a detailed action plan for completing this task on the given webpage.`;
        break;
        
      default: // 'general'
        systemPrompt = `You are an expert web content analyst and automation assistant.
                        Analyze the provided webpage content in the context of the user's command.
                        Provide insights about the page structure, content, and how it relates to the user's task.
                        Focus on practical, actionable information that would help with web automation.`;
        
        userPrompt = `Webpage Content: ${JSON.stringify(enhancedContent, null, 2)}
                      
                      User Command: ${userCommand}
                      
                      Please analyze this webpage content and provide insights relevant to the user's task.`;
    }
    
    const response = await fetch(`${OPENAI_API_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: GPT41_MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        max_tokens: 1500,
        temperature: 0.1
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'GPT-4.1 API request failed');
    }
    
    const data = await response.json();
    const analysis = data.choices[0]?.message?.content || '';
    
    console.log(`GPT-4.1 ${analysisType} analysis completed:`, analysis);
    return analysis;
  } catch (error) {
    console.error(`Error calling GPT-4.1 for ${analysisType} analysis:`, error);
    return `Error in GPT-4.1 analysis: ${error.message}`;
  }
}

// Function to intelligently understand task requirements using GPT-4.1
async function analyzeTaskRequirements(userCommand, pageContent) {
  try {
    console.log('Analyzing task requirements with GPT-4.1');
    
    const systemPrompt = `You are an expert task analysis assistant for web automation.
                          Analyze the user command and provide structured insights about:
                          1. Task type (search, navigation, form filling, data extraction, etc.)
                          2. Key requirements and constraints
                          3. Success criteria
                          4. Potential challenges or edge cases
                          5. Recommended approach strategy
                          
                          Provide your analysis in a structured JSON format:
                          {
                            "taskType": "category of task",
                            "requirements": ["list of requirements"],
                            "successCriteria": ["list of success indicators"],
                            "challenges": ["potential issues"],
                            "strategy": "recommended approach",
                            "priority": "high/medium/low",
                            "estimatedComplexity": "simple/moderate/complex"
                          }`;
    
    const userPrompt = `User Command: "${userCommand}"
                        
                        Current Page Context: ${getEnhancedPageContentSummary(pageContent)}
                        
                        Please analyze this task and provide structured insights.`;
    
    const response = await fetch(`${OPENAI_API_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: GPT41_MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        max_tokens: 800,
        temperature: 0.1
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'GPT-4.1 task analysis failed');
    }
    
    const data = await response.json();
    const analysis = data.choices[0]?.message?.content || '';
    
    try {
      // Try to parse as JSON
      return JSON.parse(analysis);
    } catch (parseError) {
      // If not JSON, return as structured text
      return {
        taskType: 'unknown',
        analysis: analysis,
        error: 'Could not parse as structured JSON'
      };
    }
  } catch (error) {
    console.error('Error analyzing task requirements:', error);
    return {
      taskType: 'unknown',
      error: error.message
    };
  }
}

// Function to extract specific information using GPT-4.1
async function extractSpecificInformation(pageContent, extractionTarget, context = '') {
  try {
    console.log(`Extracting specific information: ${extractionTarget}`);
    
    const systemPrompt = `You are an expert information extraction assistant.
                          Your job is to extract specific information from webpage content with high accuracy.
                          
                          Guidelines:
                          1. Focus only on the requested information
                          2. Provide exact values when possible
                          3. If information is not found, state clearly that it's not available
                          4. Include relevant context that might help with task completion
                          5. Format your response clearly and concisely
                          
                          Extract the information in a structured format when possible.`;
    
    const userPrompt = `Webpage Content: ${JSON.stringify(pageContent, null, 2)}
                        
                        Extract Target: ${extractionTarget}
                        
                        Additional Context: ${context}
                        
                        Please extract the requested information from the webpage content.`;
    
    const response = await fetch(`${OPENAI_API_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: GPT41_MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        max_tokens: 1000,
        temperature: 0.1
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'GPT-4.1 information extraction failed');
    }
    
    const data = await response.json();
    const extractedInfo = data.choices[0]?.message?.content || '';
    
    console.log('Information extraction completed:', extractedInfo);
    return extractedInfo;
  } catch (error) {
    console.error('Error extracting specific information:', error);
    return `Error in information extraction: ${error.message}`;
  }
} 