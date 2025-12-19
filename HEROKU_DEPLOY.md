# Heroku Deployment Guide for Browser Bot

## Prerequisites

1. Heroku CLI installed: https://devcenter.heroku.com/articles/heroku-cli
2. Git repository initialized
3. Heroku account

## Quick Start

### 1. Login to Heroku
```bash
heroku login
```

### 2. Create Heroku App
```bash
cd browser_bot
heroku create your-app-name
```

### 3. Set Required Environment Variables

```bash
# Required: Backend API URL
heroku config:set API_BASE_URL=https://your-backend-api.com

# Required: OpenAI API Key
heroku config:set OPENAI_API_KEY=sk-proj-...

# Optional: WebSocket URL (if not provided, bot will fetch token from API_BASE_URL)
heroku config:set OPENAI_REALTIME_WS_URL=wss://your-backend-api.com/api/realtime/ws?token=...

# Optional: Other settings
heroku config:set LOG_LEVEL=info
heroku config:set HEADLESS=true
heroku config:set SHOULD_SEND_STATUS=false
```

### 4. Deploy

```bash
# Deploy from current directory
git add .
git commit -m "Deploy to Heroku"
git push heroku main

# Or if your branch is not 'main'
git push heroku HEAD:main
```

### 5. Check Logs

```bash
heroku logs --tail
```

## Important Notes

### System Dependencies
Heroku's Node.js buildpack includes most system dependencies needed for Playwright, but if you encounter issues, you may need to add a custom buildpack:

```bash
# Add Apt buildpack for additional system packages (if needed)
heroku buildpacks:add --index 1 heroku-community/apt
```

Then create `Aptfile` in the root with required packages:
```
libnss3
libatk-bridge2.0-0
libdrm2
libxkbcommon0
libxcomposite1
libxdamage1
libxrandr2
libgbm1
libxss1
libasound2
libxfixes3
libxshmfence1
libxcb1
libx11-6
libx11-xcb1
libxext6
libxrender1
libcups2
libgl1-mesa-dri
```

### Audio Dependencies
**Note**: Heroku dynos don't have audio devices. The bot will work but:
- Audio capture may be limited
- PulseAudio/ALSA won't be available
- Consider using headless mode only

### Ephemeral Filesystem
- Auth state files (`google_auth_state.json`) won't persist across dyno restarts
- Consider storing auth state in a database or external storage
- Or re-authenticate on each dyno restart

### Resource Limits
- Standard-1X dyno: 512MB RAM, 1 CPU
- For multiple concurrent bots, consider:
  - Performance-M (2.5GB RAM, 2 CPU)
  - Performance-L (14GB RAM, 8 CPU)

### Scaling
```bash
# Scale to multiple dynos (if needed)
heroku ps:scale web=2
```

### Health Check
The app includes a health check endpoint:
```
GET /health
```

You can configure Heroku to use this:
```bash
heroku features:enable http-session-affinity
```

## Troubleshooting

### Playwright Browser Not Found
If you see errors about Playwright browsers:
```bash
# Check if browsers are installed
heroku run npx playwright install chromium

# Or set environment variable to skip browser download (if using custom path)
heroku config:set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
```

### Port Binding
The app automatically uses `process.env.PORT` (set by Heroku). No changes needed.

### Memory Issues
If you see memory errors:
1. Upgrade to a larger dyno type
2. Reduce concurrent bot instances
3. Monitor with: `heroku logs --tail`

### Build Timeout
If build times out:
1. The `postinstall` script installs Playwright browsers (can take 2-3 minutes)
2. Consider using a custom buildpack or pre-built browsers

## Environment Variables Reference

### Required
- `API_BASE_URL` - Backend API URL (e.g., `https://api.example.com`)
- `OPENAI_API_KEY` - OpenAI API key

### Optional
- `OPENAI_REALTIME_WS_URL` - WebSocket URL with token (if not provided, bot fetches from API_BASE_URL)
- `LOG_LEVEL` - Logging level (default: `info`)
- `HEADLESS` - Run browser in headless mode (default: `true`)
- `SHOULD_SEND_STATUS` - Send status updates to backend (default: `false`)
- `BROWSER_ENGINE` - Browser engine (`chromium` or `chrome`, default: `chromium`)
- `BROWSER_LOCALE` - Browser locale (default: `en-US`)
- `NAVIGATION_TIMEOUT_MS` - Navigation timeout (default: `45000`)

## API Endpoints

Once deployed, your bot server will be available at:
- `https://your-app-name.herokuapp.com`

Endpoints:
- `GET /health` - Health check
- `POST /start-meeting` - Start a new meeting bot
- `DELETE /stop-meeting/:meetingId` - Stop a meeting bot
- `GET /meetings` - List active meetings
- `GET /meetings/:meetingId` - Get meeting status
- `GET /meetings/:meetingId/logs` - Get meeting logs

## Updating the App

```bash
# Make changes, then:
git add .
git commit -m "Update bot"
git push heroku main
```

## Monitoring

```bash
# View logs
heroku logs --tail

# View specific meeting logs (via API)
curl https://your-app-name.herokuapp.com/meetings/{meetingId}/logs

# Check dyno status
heroku ps
```

