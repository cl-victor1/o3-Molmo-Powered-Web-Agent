// Initialize context for maintaining conversation history
let conversationHistory = [];

// Map to store tab-specific information
const tabContext = new Map();

// Map to track ongoing task executions
const taskExecutions = new Map();

// API Keys
let OPENAI_API_KEY = "";

// Molmo API Configuration
const MOLMO_API_URL = "http://localhost:8000/molmo/point"; // SSH tunnel to Hyak Molmo service
const MOLMO_OFFICIAL_API_URL = "https://ai2-reviz--uber-model-v4-synthetic.modal.run/completion_stream"; // Official Molmo API
let MOLMO_API_KEY = ""; // Add your Molmo API key here

// Molmo API selection: 'local' or 'official'
let MOLMO_API_TYPE = 'local'; // Change to 'official' to use the official API

// Load saved API keys and configuration on startup
chrome.storage.sync.get(['openai_api_key', 'molmo_api_key', 'molmo_api_type'], function(result) {
  if (result.openai_api_key) {
    OPENAI_API_KEY = result.openai_api_key;
    console.log('Loaded OpenAI API key from storage');
  }
  if (result.molmo_api_key) {
    MOLMO_API_KEY = result.molmo_api_key;
    console.log('Loaded Molmo API key from storage');
  }
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
    
    // Store API key in Chrome storage
    chrome.storage.sync.set({ 'openai_api_key': apiKey }, function() {
      OPENAI_API_KEY = apiKey;
      console.log('OpenAI API key saved to storage');
      sendResponse({ success: true });
    });
    
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
  
  // Handle setting Molmo API key
  if (request.action === 'setMolmoApiKey') {
    const { apiKey } = request;
    
    // Store Molmo API key in Chrome storage
    chrome.storage.sync.set({ 'molmo_api_key': apiKey }, function() {
      MOLMO_API_KEY = apiKey;
      console.log('Molmo API key saved to storage');
      sendResponse({ success: true });
    });
    
    return true;
  }
  
  // Handle getting Molmo API key status
  if (request.action === 'getMolmoApiKeyStatus') {
    sendResponse({ 
      hasApiKey: !!MOLMO_API_KEY,
      apiKeySet: !!MOLMO_API_KEY
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
    // Get page content for context
    let pageContent = '';
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // Check if the URL is accessible
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('edge://')) {
        console.log('Cannot access restricted URL for content extraction:', tab.url);
        pageContent = `Restricted URL: ${tab.url}`;
      } else {
        // Execute content script to get page information
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          function: getPageContent
        });
        
        // Extract page content from script execution result
        if (result && result[0] && result[0].result) {
          pageContent = result[0].result;
        }
      }
    } catch (error) {
      console.error('Error getting page content:', error);
      // Continue with empty page content if there's an error
    }
    
    // Update conversation history with user command
    conversationHistory.push({
      role: 'user',
      content: `Current URL: ${url}\nPage content summary: ${getPageContentSummary(pageContent)}\n\nUser command: ${command}`
    });
    
    // Make sure history doesn't get too long (keep last 10 messages)
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 10);
    }
    
    // Check if we have an API key
    const finalApiKey = apiKey || OPENAI_API_KEY;
    if (!finalApiKey) {
      throw new Error('No OpenAI API key available. Please set your API key in the extension popup.');
    }
    
    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalApiKey}`
      },
      body: JSON.stringify({
        model: 'o3',
        messages: [
          {
            role: 'system',
            content: `You are a helpful web browser assistant that can automate browsing tasks. 
                      You'll be given a user command and information about the current webpage.
                      Respond with specific actions to take, formatted as a JSON object.
                      
                      You can use these actions:
                      {"action": "click", "selector": "button.submit-btn"}
                      {"action": "click", "object_name": "search button"}
                      {"action": "type", "selector": "input#search", "text": "search query"}
                      {"action": "navigate", "url": "https://example.com"}
                      {"action": "extract", "selector": "div.results"}
                      {"action": "wait", "time": 2000}
                      {"action": "scroll", "direction": "down", "amount": 500}
                      
                      For the "click" action, you can use either:
                      1. CSS selector: {"action": "click", "selector": "button.submit-btn"}
                      2. Visual description: {"action": "click", "object_name": "search button"}
                      
                      When using object_name, provide a clear description of what to click on the screen. 
                      This uses the Molmo API to identify objects visually even without precise selectors.
                      
                      IMPORTANT: For YouTube videos, use specific descriptions like:
                      - "first video" or "first video thumbnail" for the first video in the list
                      - "second video" for the second video
                      - "video titled [title]" for a specific video by title
                      
                      
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
      
      // Save to persistent storage
      chrome.storage.local.set({
        [`tab_${tabId}_command`]: command,
        [`tab_${tabId}_response`]: aiResponse
      });
    }
    
    // Try to parse action from response
    let actions = null;
    try {
      console.log('AI Response received:', aiResponse);
      // Extract JSON object or array from the response
      const jsonMatch = aiResponse.match(/(\{.*\}|\[.*\])/s);
      console.log('JSON match found:', jsonMatch);
      if (jsonMatch) {
        console.log('Attempting to parse JSON:', jsonMatch[0]);
        actions = JSON.parse(jsonMatch[0]);
        console.log('Parsed actions:', actions);
      } else {
        console.log('No JSON pattern found in AI response');
      }
    } catch (error) {
      console.error('Error parsing action JSON:', error);
      console.error('Failed to parse:', jsonMatch ? jsonMatch[0] : 'No match');
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
            
            // Format the object name as required by Molmo
            const formattedObjectName = `pointing: Point to ${action.object_name}`;
            
            console.log(`Calling Molmo API to locate: "${action.object_name}" with prompt: "${formattedObjectName}"`);
            
            // Add special handling for YouTube video elements
            if (tab.url.includes('youtube.com') && action.object_name.includes('video')) {
              console.log('YouTube context detected - optimizing for video element detection');
            }
            
            // Call Molmo API to get points
            console.log('About to call Molmo API...');
            const points = await callMolmoAPI(base64Image, formattedObjectName);
            console.log('Molmo API call completed, received points:', points);
            
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
              throw new Error(`Failed to locate "${action.object_name}" on screen`);
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
  const MAX_RECURSION_DEPTH = 3; // Prevent infinite loops
  
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
    
    // Get page content for analysis
    let pageContent = '';
    
    try {
      // Execute content script to get page information
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        function: getPageContent
      });
      
      // Extract page content from script execution result
      if (result && result[0] && result[0].result) {
        pageContent = result[0].result;
      }
    } catch (error) {
      console.error('Error getting page content:', error);
      return "Task execution completed, but couldn't analyze the page content.";
    }
    
    // Get context for this tab
    const context = tabContext.get(tabId) || { lastCommand: '' };
    const lastCommand = context.lastCommand || '';
    
    // Update conversation history with current page state
    conversationHistory.push({
      role: 'user',
      content: `Current URL: ${url}\nPage content summary: ${getPageContentSummary(pageContent)}\n\nIs the task "${lastCommand}" completed? If not, what additional steps are needed?`
    });
    
    // Call OpenAI API to analyze task completion
    if (!OPENAI_API_KEY) {
      throw new Error('No OpenAI API key available for task analysis.');
    }
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'o3',
        messages: [
          {
            role: 'system',
            content: `You are a helpful web browser automation assistant.
                      Analyze the current page content and URL to determine if the user's task has been completed.
                      If the task is complete, respond with "TASK_COMPLETED: " followed by a brief summary.
                      If the task is incomplete, respond with "TASK_INCOMPLETE: " followed by a JSON array of actions needed to complete the task.
                      
                      IMPORTANT: Be conservative about continuing tasks. If you're unsure or if the page seems to have changed appropriately, 
                      consider the task completed rather than continuing indefinitely.
                      
                      Use the following action formats:
                      {"action": "click", "selector": "button.submit-btn"}
                      {"action": "type", "selector": "input#search", "text": "search query"}
                      {"action": "navigate", "url": "https://example.com"}
                      {"action": "extract", "selector": "div.results"}
                      {"action": "wait", "time": 2000}
                      {"action": "scroll", "direction": "down", "amount": 500}
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
      
      // Save to persistent storage
      chrome.storage.local.set({
        [`tab_${tabId}_response`]: aiResponse
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

// Function to call Official Molmo API (based on test_molmo_api.py)
async function callMolmoOfficialAPI(imageBase64, objectName) {
  const MAX_RETRIES = 3;
  let retryCount = 0;
  
  // Check if we have the API key
  if (!MOLMO_API_KEY) {
    throw new Error('No Molmo API key available. Please set your Molmo API key in the extension.');
  }
  
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
          const delay = 2000 * retryCount; // Exponential backoff
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
      
      // Parse coordinates from the response text
      // The response typically contains coordinate information
      const points = parseCoordinatesFromText(responseText);
      
      if (points && points.length > 0) {
        console.log(`Official Molmo found ${points.length} points:`, points);
        return points;
      } else {
        console.error('No points found in Official Molmo API response');
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 2000 * retryCount; // Exponential backoff
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
        const delay = 2000 * retryCount; // Exponential backoff
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
  console.log(`Using Molmo API type: ${MOLMO_API_TYPE}`);
  
  if (MOLMO_API_TYPE === 'official') {
    return await callMolmoOfficialAPI(imageBase64, objectName);
  } else {
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
          const delay = 2000 * retryCount; // Exponential backoff
          console.log(`Will retry in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return [];
      }
      
      // Parse the response
      const result = await response.json();
      console.log('Received response from Molmo API:', result);
      
      // Check for errors
      if (result.error) {
        console.error(`Error from Molmo API: ${result.error}`);
        
        // Increase retry count and try again after delay
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          const delay = 2000 * retryCount; // Exponential backoff
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
          const delay = 2000 * retryCount; // Exponential backoff
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
        const delay = 2000 * retryCount; // Exponential backoff
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