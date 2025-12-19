# Browser Bot

Headless browser bot for joining meetings and streaming audio via OpenAI Realtime API.

## Features

- Join Google Meet, Microsoft Teams, and Zoom meetings
- Real-time audio streaming to/from OpenAI Realtime API
- HTTP API for managing multiple bot instances
- Platform-specific meeting automation

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start the bot server
npm start

# Or run directly
node server.js
```

### Railway Deployment

See [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md) for detailed deployment instructions.

**Quick Steps:**
1. Create Railway service
2. Set Root Directory to `browser_bot`
3. Add environment variables
4. Deploy!

## Environment Variables

### Required
- `API_BASE_URL` - Backend API URL
- `OPENAI_API_KEY` - OpenAI API key

### Optional
- `PORT` - Server port (default: 3001)
- `LOG_LEVEL` - Logging level (default: info)
- `HEADLESS` - Run browser in headless mode (default: true)
- `SHOULD_SEND_STATUS` - Send status updates to backend (default: false)

## API Endpoints

- `POST /start-meeting` - Start a new bot instance
- `DELETE /stop-meeting/:meetingId` - Stop a bot instance
- `GET /meetings/:meetingId` - Get meeting status
- `GET /health` - Health check

## Architecture

- `server.js` - Express HTTP server for managing bots
- `bot_entry_v2.js` - Main bot logic and BrowserBot class
- `platforms/` - Platform-specific implementations (Google Meet, Teams, Zoom)

## Requirements

- Node.js >= 18.0.0
- Playwright Chromium (installed automatically)

