# Web Browser AI Agent

AI-powered web browser automation using natural language commands with Molmo API integration for visual understanding.

## Features

- **Natural Language Commands**: Control your browser using simple English commands
- **Visual Understanding**: Uses Molmo API to identify and interact with visual elements on web pages
- **Dual Molmo API Support**: Choose between local API and official API
- **YouTube Integration**: Specialized support for YouTube video interactions
- **Auto-execution Mode**: AI can automatically complete entire tasks without manual intervention
- **Conversation History**: Maintains context across multiple commands

## Setup

1. Load the extension in Chrome Developer Mode
2. Enter your OpenAI API key in the popup
3. Configure your preferred Molmo API type (Local or Official)

## Molmo API Dual Implementation

This extension supports two different ways to call the Molmo API:

### 1. Local API
- **URL**: `http://localhost:8000/molmo/point`
- **Purpose**: Connect to Hyak Molmo service via SSH tunnel
- **Advantages**: 
  - Faster response
  - Good for development and testing
- **Disadvantages**: Requires local server setup

### 2. Official API
- **URL**: `https://ai2-reviz--uber-model-v4-synthetic.modal.run/completion_stream`
- **Purpose**: Direct connection to AI2's official Molmo API
- **Advantages**:
  - No local server required
  - Stable and reliable
  - Supports streaming responses
- **Disadvantages**: None (API key is hardcoded in extension)

## Configuration

### Via Extension Popup:

1. **Select API Type**:
   - In the "Molmo API Configuration" section
   - Choose "Local API" or "Official API" from dropdown
   - Click "Save" to save settings

### Via Code Configuration:

```javascript
// In background.js, modify these constants:

// Choose API type: 'local' or 'official'
let MOLMO_API_TYPE = 'local';  // Change to 'official' for official API

// Official API key is hardcoded in the extension
const MOLMO_API_KEY = "OYJnOH/zlDPN0DLq";
```

## API Response Format Differences

### Local API Response Format:
```json
{
  "points": [
    {
      "point": [x, y]
    }
  ]
}
```

### Official API Response Format:
Streaming response, one JSON object per line:
```json
{"result": {"output": {"text": "coordinate information in text"}}}
```

## YouTube Video Commands

The extension has specialized support for YouTube interactions. Here are some example commands:

### Opening Videos
- **"Open the first video"** 
- **"Click the first video"** 
- **"Play the first video"** 
- **"Click on the second video"**
- **"Play the video titled [specific title]"**

### How It Works

1. **Command Processing**: Your natural language command is sent to OpenAI API
2. **Action Generation**: AI generates a `click` action with object description
3. **Visual Recognition**: Molmo API analyzes the screenshot to find the target element
4. **Coordinate Extraction**: Molmo returns precise coordinates of the target
5. **Click Simulation**: Extension simulates a mouse click at those coordinates

### Example Flow

```
User Input: "Open the first video"
↓
OpenAI Response: {"action": "click", "object_name": "first video"}
↓
Screenshot Capture: Current page screenshot
↓
Molmo API Call: "pointing: Point to first video"
↓
Coordinate Response: {x: 320, y: 240}
↓
Click Execution: Mouse click at (320, 240)
↓
Result: First video opens
```

## Implementation Details

The code automatically chooses the appropriate API based on `MOLMO_API_TYPE`:

- `callMolmoAPI()` - Main routing function that selects API based on configuration
- `callMolmoLocalAPI()` - Calls the local API  
- `callMolmoOfficialAPI()` - Calls the official API
- `parseCoordinatesFromText()` - Parses coordinates from official API text responses

## Error Handling

Both APIs implement the same retry mechanism:
- Maximum 3 retries
- Exponential backoff algorithm
- Detailed error logging

## Switching API Types

You can switch API types anytime in the extension popup without restarting the extension. Configuration is automatically saved to Chrome storage.

## Usage Tips

1. **Be Specific**: Use clear descriptions like "first video" rather than just "video"
2. **Auto-Execute Mode**: Enable for fully automated task completion
3. **YouTube Context**: The AI understands YouTube-specific terminology
4. **Error Handling**: The system will retry failed operations automatically

## Supported Actions

- `click`: Click on elements using CSS selectors or visual descriptions (Molmo API)
- `type`: Type text into input fields
- `navigate`: Navigate to URLs
- `extract`: Extract text content from elements
- `wait`: Wait for specified time
- `scroll`: Scroll the page

## Troubleshooting

- **No coordinates returned**: Ensure the Molmo API is running and accessible
- **Click not working**: Check if the page allows programmatic clicks
- **API errors**: Verify your OpenAI API key and Molmo server status
- **Local API connection issues**: Check if SSH tunnel is active and local server is running
- **Official API errors**: Check console logs for detailed error information