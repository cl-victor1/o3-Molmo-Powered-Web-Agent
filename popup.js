document.addEventListener('DOMContentLoaded', function() {
  // DOM elements
  const apiKeyInput = document.getElementById('apiKey');
  const saveApiKeyButton = document.getElementById('saveApiKey');
  const apiKeyMessage = document.getElementById('apiKeyMessage');
  const userCommandTextarea = document.getElementById('userCommand');
  const executeCommandButton = document.getElementById('executeCommand');
  const responseText = document.getElementById('responseText');
  const loadingSpinner = document.getElementById('loadingSpinner');
  
  // Molmo API configuration DOM elements
  const molmoApiTypeSelect = document.getElementById('molmoApiType');
  const saveMolmoApiTypeButton = document.getElementById('saveMolmoApiType');
  const molmoApiKeyInput = document.getElementById('molmoApiKey');
  const saveMolmoApiKeyButton = document.getElementById('saveMolmoApiKey');
  const molmoApiKeyMessage = document.getElementById('molmoApiKeyMessage');
  const molmoApiKeySection = document.getElementById('molmoApiKeySection');
  
  // Create status indicator for background tasks
  const statusContainer = document.createElement('div');
  statusContainer.className = 'status-container';
  statusContainer.innerHTML = `
    <div id="taskStatus" class="task-status"></div>
    <div id="backgroundNotice" class="background-notice">Tasks will continue running even if popup is closed.</div>
  `;
  document.querySelector('.container').appendChild(statusContainer);
  
  // Get the task status element
  const taskStatusElement = document.getElementById('taskStatus');
  
  // Add auto-execute checkbox
  const commandSection = document.getElementById('commandSection');
  const autoExecuteContainer = document.createElement('div');
  autoExecuteContainer.className = 'auto-execute-container';
  autoExecuteContainer.innerHTML = `
    <label for="autoExecute">
      <input type="checkbox" id="autoExecute">
      Auto-execute all tasks (AI will automatically complete the entire task)
    </label>
  `;
  commandSection.appendChild(autoExecuteContainer);
  
  const autoExecuteCheckbox = document.getElementById('autoExecute');
  
  // Load auto-execute preference
  chrome.storage.local.get(['autoExecute'], function(result) {
    // Default to checked if not set previously
    autoExecuteCheckbox.checked = result.autoExecute !== false;
    // Save the default state if needed
    if (result.autoExecute === undefined) {
      chrome.storage.local.set({ autoExecute: true });
    }
  });
  
  // Save auto-execute preference when changed
  autoExecuteCheckbox.addEventListener('change', function() {
    chrome.storage.local.set({ autoExecute: autoExecuteCheckbox.checked });
  });

  // Load the saved API key if it exists
  chrome.storage.local.get(['openaiApiKey'], function(result) {
    if (result.openaiApiKey) {
      apiKeyInput.value = result.openaiApiKey;
      apiKeyMessage.textContent = 'API key saved';
      apiKeyMessage.style.color = '#4CAF50';
    }
  });
  
  // Load Molmo API configuration
  chrome.runtime.sendMessage({ action: 'getMolmoApiType' }, function(response) {
    if (response && response.apiType) {
      molmoApiTypeSelect.value = response.apiType;
      updateMolmoApiKeyVisibility(response.apiType);
    }
  });
  
  chrome.runtime.sendMessage({ action: 'getMolmoApiKeyStatus' }, function(response) {
    if (response && response.hasApiKey) {
      molmoApiKeyMessage.textContent = 'Molmo API key saved';
      molmoApiKeyMessage.style.color = '#4CAF50';
    }
  });
  
  // Add debug status display
  const debugContainer = document.createElement('div');
  debugContainer.className = 'debug-container';
  debugContainer.innerHTML = `
    <div class="debug-info">
      <strong>Debug Info:</strong>
      <div id="currentApiType">Current API Type: Loading...</div>
      <button id="refreshApiType" class="debug-button">Refresh API Type</button>
    </div>
  `;
  molmoApiKeySection.parentNode.insertBefore(debugContainer, molmoApiKeySection.nextSibling);
  
  // Function to show/hide Molmo API key section based on selected type
  function updateMolmoApiKeyVisibility(apiType) {
    if (apiType === 'official') {
      molmoApiKeySection.style.display = 'block';
    } else {
      molmoApiKeySection.style.display = 'none';
    }
  }
  
  // Molmo API type selection handler
  molmoApiTypeSelect.addEventListener('change', function() {
    updateMolmoApiKeyVisibility(molmoApiTypeSelect.value);
    // Automatically save when the selection changes
    const apiType = molmoApiTypeSelect.value;
    
    chrome.runtime.sendMessage({
      action: 'setMolmoApiType',
      apiType: apiType
    }, function(response) {
      if (response && response.success) {
        console.log('Molmo API type auto-saved:', apiType);
        // Add visual feedback that it was saved
        const typeLabel = document.querySelector('label[for="molmoApiType"]');
        if (typeLabel) {
          const originalText = typeLabel.textContent;
          typeLabel.textContent = originalText + ' ✓ Saved';
          typeLabel.style.color = '#4CAF50';
          setTimeout(() => {
            typeLabel.textContent = originalText;
            typeLabel.style.color = '';
          }, 2000);
        }
        updateMolmoApiKeyVisibility(apiType);
      }
    });
  });
  
  // Save Molmo API type
  saveMolmoApiTypeButton.addEventListener('click', function() {
    const apiType = molmoApiTypeSelect.value;
    
    chrome.runtime.sendMessage({
      action: 'setMolmoApiType',
      apiType: apiType
    }, function(response) {
      if (response && response.success) {
        console.log('Molmo API type saved:', apiType);
        // Add visual feedback
        const button = saveMolmoApiTypeButton;
        const originalText = button.textContent;
        button.textContent = 'Saved!';
        button.style.backgroundColor = '#4CAF50';
        setTimeout(() => {
          button.textContent = originalText;
          button.style.backgroundColor = '';
        }, 2000);
        updateMolmoApiKeyVisibility(apiType);
      }
    });
  });
  
  // Save Molmo API key
  saveMolmoApiKeyButton.addEventListener('click', function() {
    const apiKey = molmoApiKeyInput.value.trim();
    
    if (apiKey === '') {
      molmoApiKeyMessage.textContent = 'Please enter a valid Molmo API key';
      molmoApiKeyMessage.style.color = '#F44336';
      return;
    }
    
    chrome.runtime.sendMessage({
      action: 'setMolmoApiKey',
      apiKey: apiKey
    }, function(response) {
      if (response && response.success) {
        molmoApiKeyMessage.textContent = 'Molmo API key saved';
        molmoApiKeyMessage.style.color = '#4CAF50';
        molmoApiKeyInput.value = ''; // Clear the input for security
      }
    });
  });
  
  // Load previous user command from storage
  chrome.storage.local.get(['lastUserCommand'], function(result) {
    if (result.lastUserCommand) {
      userCommandTextarea.value = result.lastUserCommand;
    }
  });
  
  // Check for running tasks when popup opens
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    const activeTab = tabs[0];
    
    // Request task status from background script
    chrome.runtime.sendMessage({
      action: 'getTaskStatus',
      tabId: activeTab.id
    }, function(status) {
      updateTaskStatus(status);
    });
    
    // Request conversation data from background script
    chrome.runtime.sendMessage({
      action: 'getConversationData',
      tabId: activeTab.id
    }, function(response) {
      if (response && response.lastResponse) {
        // Display the last response
        responseText.textContent = response.lastResponse;
      }
    });
  });
  
  // Function to update task status display
  function updateTaskStatus(status) {
    if (status && status.running) {
      // Calculate how long the task has been running
      const runningTime = Math.floor((Date.now() - status.startTime) / 1000);
      taskStatusElement.innerHTML = `
        <span class="status-icon running"></span>
        Task "${status.command}" running (${runningTime}s)
        <button id="stopTaskButton" class="stop-button">Stop Task</button>
      `;
      taskStatusElement.className = 'task-status running';
      
      // Add event listener to stop button
      const stopButton = document.getElementById('stopTaskButton');
      stopButton.addEventListener('click', function() {
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          const activeTab = tabs[0];
          chrome.runtime.sendMessage({
            action: 'stopTask',
            tabId: activeTab.id
          }, function(response) {
            if (response && response.success) {
              taskStatusElement.innerHTML = `
                <span class="status-icon stopped"></span>
                Task stopped by user
              `;
              taskStatusElement.className = 'task-status stopped';
            }
          });
        });
      });
      
      // Set timer to update the running time
      setTimeout(() => {
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          const activeTab = tabs[0];
          chrome.runtime.sendMessage({
            action: 'getTaskStatus',
            tabId: activeTab.id
          }, updateTaskStatus);
        });
      }, 1000);
    } else if (status && status.completed) {
      taskStatusElement.innerHTML = `
        <span class="status-icon completed"></span>
        Task completed successfully
      `;
      taskStatusElement.className = 'task-status completed';
    } else if (status && status.stopped) {
      taskStatusElement.innerHTML = `
        <span class="status-icon stopped"></span>
        Task stopped by user
      `;
      taskStatusElement.className = 'task-status stopped';
    } else if (status && status.error) {
      taskStatusElement.innerHTML = `
        <span class="status-icon error"></span>
        Task failed: ${status.error}
      `;
      taskStatusElement.className = 'task-status error';
    } else {
      taskStatusElement.innerHTML = '';
      taskStatusElement.className = 'task-status';
    }
  }

  // Save API key to Chrome storage
  saveApiKeyButton.addEventListener('click', function() {
    const apiKey = apiKeyInput.value.trim();
    
    if (apiKey === '') {
      apiKeyMessage.textContent = 'Please enter a valid API key';
      apiKeyMessage.style.color = '#F44336';
      return;
    }
    
    chrome.storage.local.set({ openaiApiKey: apiKey }, function() {
      apiKeyMessage.textContent = 'API key saved';
      apiKeyMessage.style.color = '#4CAF50';
    });
  });

  // Execute command when button is clicked
  executeCommandButton.addEventListener('click', function() {
    executeCommand();
  });

  // Execute command when Enter key is pressed
  userCommandTextarea.addEventListener('keydown', function(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      executeCommand();
    }
  });
  
  // Save command to storage when user types
  userCommandTextarea.addEventListener('input', function() {
    const userCommand = userCommandTextarea.value.trim();
    chrome.storage.local.set({ lastUserCommand: userCommand });
  });

  // Function to execute the command
  function executeCommand() {
    const userCommand = userCommandTextarea.value.trim();
    
    if (userCommand === '') {
      responseText.textContent = 'Please enter a command';
      return;
    }

    // Save the current command to local storage
    chrome.storage.local.set({ lastUserCommand: userCommand });

    // Get the API key
    chrome.storage.local.get(['openaiApiKey'], function(result) {
      if (!result.openaiApiKey) {
        responseText.textContent = 'Please enter your OpenAI API key first';
        return;
      }

      // Show loading spinner
      loadingSpinner.style.display = 'block';
      responseText.textContent = '';

      // Get the active tab
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        const activeTab = tabs[0];
        
        // Send message to background script
        chrome.runtime.sendMessage({
          action: 'executeCommand',
          command: userCommand,
          apiKey: result.openaiApiKey,
          tabId: activeTab.id,
          url: activeTab.url,
          autoExecute: autoExecuteCheckbox.checked
        }, function(response) {
          // Hide loading spinner
          loadingSpinner.style.display = 'none';
          
          if (response.error) {
            responseText.textContent = 'Error: ' + response.error;
          } else {
            responseText.textContent = response.result || 'Command executed successfully!';
            
            // Request updated task status
            chrome.runtime.sendMessage({
              action: 'getTaskStatus',
              tabId: activeTab.id
            }, updateTaskStatus);
          }
        });
      });
    });
  }
  
  // Add CSS for status indicators
  const style = document.createElement('style');
  style.textContent = `
    .status-container {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #eee;
    }
    
    .task-status {
      display: flex;
      align-items: center;
      font-size: 14px;
      min-height: 24px;
      margin-bottom: 8px;
    }
    
    .task-status.running {
      color: #1a73e8;
    }
    
    .task-status.completed {
      color: #0f9d58;
    }
    
    .task-status.error {
      color: #ea4335;
    }
    
    .task-status.stopped {
      color: #ff9800;
    }
    
    .status-icon {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
    }
    
    .status-icon.running {
      background-color: #1a73e8;
      animation: pulse 1.5s infinite;
    }
    
    .status-icon.completed {
      background-color: #0f9d58;
    }
    
    .status-icon.error {
      background-color: #ea4335;
    }
    
    .status-icon.stopped {
      background-color: #ff9800;
    }
    
    .stop-button {
      margin-left: auto;
      padding: 4px 8px;
      background-color: #ea4335;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
    }
    
    .stop-button:hover {
      background-color: #d33b2c;
    }
    
    .background-notice {
      font-size: 12px;
      color: #5f6368;
      font-style: italic;
      margin-top: 4px;
    }
    
    @keyframes pulse {
      0% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
      100% {
        opacity: 1;
      }
    }
  `;
  document.head.appendChild(style);

  // Function to update debug display
  function updateDebugDisplay() {
    chrome.runtime.sendMessage({ action: 'getMolmoApiType' }, function(response) {
      const display = document.getElementById('currentApiType');
      if (response && response.apiType) {
        display.textContent = `Current API Type: ${response.apiType}`;
        display.style.color = response.apiType === 'official' ? '#4CAF50' : '#FF9800';
      } else {
        display.textContent = 'Current API Type: Not set (default: local)';
        display.style.color = '#666';
      }
    });
  }
  
  // Initial debug display update
  updateDebugDisplay();
  
  // Refresh button event listener
  document.getElementById('refreshApiType').addEventListener('click', updateDebugDisplay);

  // Add CSS styles for the debug container
  const debugStyle = document.createElement('style');
  debugStyle.textContent = `
    @keyframes pulse {
      0% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
      100% {
        opacity: 1;
      }
    }
    
    .debug-container {
      margin-top: 15px;
      padding: 10px;
      background-color: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 4px;
      font-size: 12px;
    }
    
    .debug-info {
      margin-bottom: 5px;
    }
    
    .debug-button {
      padding: 4px 8px;
      background-color: #6c757d;
      color: white;
      border: none;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      margin-top: 5px;
    }
    
    .debug-button:hover {
      background-color: #5a6268;
    }
    
    #currentApiType {
      margin: 5px 0;
      font-family: monospace;
      font-weight: bold;
    }
  `;
  document.head.appendChild(debugStyle);
}); 