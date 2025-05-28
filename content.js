// Listen for messages from the background script
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'executeActions') {
    const actions = request.actions;
    executeActions(actions)
      .then(result => {
        sendResponse({ success: true, result });
      })
      .catch(error => {
        console.error('Error executing actions:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Indicates async response
  }
  return false;
});

// Execute a sequence of actions
async function executeActions(actions) {
  const results = [];
  
  for (const action of actions) {
    try {
      const result = await executeAction(action);
      results.push({
        action: action.action,
        success: true,
        result
      });
    } catch (error) {
      results.push({
        action: action.action,
        success: false,
        error: error.message
      });
      // Stop execution if an action fails
      break;
    }
  }
  
  return results;
}

// Execute a single action
async function executeAction(action) {
  const { action: actionType } = action;
  
  switch (actionType) {
    case 'click':
      return await clickElement(action.selector);
    
    case 'type':
      return await typeInElement(action.selector, action.text);
    
    case 'navigate':
      return await navigateTo(action.url);
    
    case 'extract':
      return await extractContent(action.selector);
    
    case 'wait':
      return await wait(action.time);
    
    case 'scroll':
      return await scroll(action.direction, action.amount);
    
    case 'select':
      return await selectOption(action.selector, action.value);
    
    case 'submit':
      return await submitForm(action.selector);
    
    case 'focus':
      return await focusElement(action.selector);
    
    case 'hover':
      return await hoverElement(action.selector);
    
    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }
}

// Helper function to find an element by selector
function findElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  return element;
}

// Click on an element
async function clickElement(selector) {
  const element = findElement(selector);
  
  // Check if element is already visible in viewport before scrolling
  const rect = element.getBoundingClientRect();
  const isVisible = (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
  
  // Only scroll if element is completely out of view, and use minimal scrolling
  if (!isVisible) {
    // Check if element is above or below viewport
    if (rect.top < 0) {
      // Element is above viewport, scroll up minimally
      window.scrollBy(0, rect.top - 50); // Small buffer from top
    } else if (rect.bottom > window.innerHeight) {
      // Element is below viewport, scroll down minimally
      window.scrollBy(0, rect.bottom - window.innerHeight + 50); // Small buffer from bottom
    }
    
    // Wait a moment for the minimal scroll to complete
    await wait(300);
  }
  
  // Highlight element before clicking
  const originalBackgroundColor = element.style.backgroundColor;
  const originalOutline = element.style.outline;
  
  element.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
  element.style.outline = '2px solid #4285f4';
  
  // Wait a moment for the highlight to be visible
  await wait(300);
  
  // Simulate click
  element.click();
  
  // Remove highlight after a short delay
  await wait(300);
  element.style.backgroundColor = originalBackgroundColor;
  element.style.outline = originalOutline;
  
  return `Clicked on ${selector}`;
}

// Type text into an input field
async function typeInElement(selector, text) {
  const element = findElement(selector);
  
  // Focus the element
  element.focus();
  
  // Clear existing value
  element.value = '';
  
  // Type the text character by character with a small delay
  for (const char of text) {
    element.value += char;
    
    // Dispatch input event
    element.dispatchEvent(new Event('input', { bubbles: true }));
    
    // Small delay between characters for more natural typing
    await wait(50);
  }
  
  // Dispatch change event
  element.dispatchEvent(new Event('change', { bubbles: true }));
  
  return `Typed "${text}" into ${selector}`;
}

// Navigate to a URL
async function navigateTo(url) {
  window.location.href = url;
  return `Navigating to ${url}`;
}

// Extract content from an element
async function extractContent(selector) {
  const element = findElement(selector);
  
  // Highlight element
  const originalBackgroundColor = element.style.backgroundColor;
  const originalOutline = element.style.outline;
  
  element.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
  element.style.outline = '2px solid #4285f4';
  
  // Wait a moment for the highlight to be visible
  await wait(500);
  
  // Get text content
  const content = element.innerText;
  
  // Remove highlight
  element.style.backgroundColor = originalBackgroundColor;
  element.style.outline = originalOutline;
  
  return content;
}

// Wait for a specified time
async function wait(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

// Scroll the page
async function scroll(direction, amount) {
  const scrollOptions = { behavior: 'smooth' };
  
  switch (direction) {
    case 'up':
      window.scrollBy(0, -amount);
      break;
    case 'down':
      window.scrollBy(0, amount);
      break;
    case 'left':
      window.scrollBy(-amount, 0);
      break;
    case 'right':
      window.scrollBy(amount, 0);
      break;
    case 'top':
      window.scrollTo(0, 0);
      break;
    case 'bottom':
      window.scrollTo(0, document.body.scrollHeight);
      break;
    default:
      throw new Error(`Unknown scroll direction: ${direction}`);
  }
  
  await wait(500);
  return `Scrolled ${direction} by ${amount || 'max'} pixels`;
}

// Select an option from a dropdown
async function selectOption(selector, value) {
  const element = findElement(selector);
  
  if (element.tagName !== 'SELECT') {
    throw new Error(`Element is not a select: ${selector}`);
  }
  
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  
  return `Selected option "${value}" in ${selector}`;
}

// Submit a form
async function submitForm(selector) {
  const form = findElement(selector);
  
  if (form.tagName !== 'FORM') {
    throw new Error(`Element is not a form: ${selector}`);
  }
  
  form.submit();
  return `Submitted form ${selector}`;
}

// Focus an element
async function focusElement(selector) {
  const element = findElement(selector);
  element.focus();
  
  return `Focused on ${selector}`;
}

// Hover over an element
async function hoverElement(selector) {
  const element = findElement(selector);
  
  // Create and dispatch mouse events
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  
  // Highlight the element
  const originalOutline = element.style.outline;
  element.style.outline = '2px solid #4285f4';
  
  // Wait a moment
  await wait(500);
  
  // Remove highlight
  element.style.outline = originalOutline;
  
  return `Hovered over ${selector}`;
} 