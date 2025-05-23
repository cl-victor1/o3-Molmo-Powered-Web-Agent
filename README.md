# Web Browser AI Agent

AI-powered web browser automation using natural language commands with Molmo API integration for visual understanding.

## Features

- **Natural Language Commands**: Control your browser using simple English commands
- **Visual Understanding**: Uses Molmo API to identify and interact with visual elements on web pages
- **YouTube Integration**: Specialized support for YouTube video interactions
- **Auto-execution Mode**: AI can automatically complete entire tasks without manual intervention
- **Conversation History**: Maintains context across multiple commands

## Setup

1. Load the extension in Chrome Developer Mode
2. Enter your OpenAI API key in the popup
3. Configure the Molmo API URL in `background.js` (line 14)

## YouTube Video Commands

The extension has specialized support for YouTube interactions. Here are some example commands:

### Opening Videos
- **"Open the first video"** (Open the first video)
- **"Click the first video"** (Click the first video)
- **"Play the first video"** (Play the first video)
- **"Open the first video"**
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

## Configuration

### Molmo API Setup
Update the `MOLMO_API_URL` in `background.js`:
```javascript
const MOLMO_API_URL = "http://your-molmo-server:8000/molmo/point";
```

### OpenAI API Key
Enter your API key in the extension popup or it will use the default key.

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