# Railway Deployment Guide

This guide covers deploying the browser bot to Railway.

## Prerequisites

1. Railway account (sign up at https://railway.app)
2. Railway CLI installed (optional): `npm i -g @railway/cli`
3. Git repository with your code

## Quick Deploy

### Option 1: Deploy via Railway Dashboard (Recommended)

1. **Create New Project:**
   - Go to https://railway.app
   - Click "New Project"
   - Select "Deploy from GitHub repo" (or "Empty Project" if deploying manually)

2. **Configure Service:**
   - If deploying from GitHub, select your repository
   - Railway will auto-detect Node.js and use `nixpacks.toml` configuration
   - Set root directory to `browser_bot` if deploying from monorepo

3. **Set Environment Variables:**
   - Go to your service → Variables tab
   - Add the following required variables:

```bash
# Server Configuration
PORT=3001
NODE_ENV=production

# API Configuration
API_BASE_URL=https://api.auray.net

# OpenAI Configuration
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_REALTIME_WS_URL=wss://api.openai.com/v1/realtime

# Bot Configuration
BOT_NAME=Aurray Bot
PLATFORM=google_meet
HEADLESS=true
LOG_LEVEL=info
BROWSER_ENGINE=chromium
BROWSER_LOCALE=en-US
NAVIGATION_TIMEOUT_MS=45000

# Optional
SHOULD_SEND_STATUS=false
VOICE=alloy
INSTRUCTIONS=You are a helpful meeting assistant. Keep responses concise and professional.
```

4. **Deploy:**
   - Railway will automatically build and deploy
   - Check the Deployments tab for build logs
   - Once deployed, your service will be available at `https://your-service.railway.app`

### Option 2: Deploy via Railway CLI

1. **Install Railway CLI:**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login:**
   ```bash
   railway login
   ```

3. **Initialize Project:**
   ```bash
   cd browser_bot
   railway init
   ```

4. **Set Environment Variables:**
   ```bash
   railway variables set PORT=3001
   railway variables set NODE_ENV=production
   railway variables set API_BASE_URL=https://api.auray.net
   railway variables set OPENAI_API_KEY=your-key-here
   # ... add other variables
   ```

5. **Deploy:**
   ```bash
   railway up
   ```

## Configuration Files

### `railway.json`
Railway configuration file that specifies:
- Build command
- Start command
- Health check endpoint
- Restart policy

### `nixpacks.toml`
Nixpacks build configuration that:
- Installs Node.js 18
- Installs Chromium and dependencies
- Runs npm install
- Installs Playwright Chromium

### `.railwayignore`
Files to exclude from deployment (similar to .gitignore)

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `API_BASE_URL` | Backend API URL | `https://api.auray.net` |
| `OPENAI_API_KEY` | OpenAI API key | `sk-...` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_NAME` | Bot display name | `Aurray Bot` |
| `PLATFORM` | Meeting platform | `google_meet` |
| `HEADLESS` | Run browser headless | `true` |
| `LOG_LEVEL` | Logging level | `info` |
| `BROWSER_ENGINE` | Browser engine | `chromium` |
| `BROWSER_LOCALE` | Browser locale | `en-US` |
| `NAVIGATION_TIMEOUT_MS` | Navigation timeout | `45000` |
| `SHOULD_SEND_STATUS` | Send status updates | `false` |
| `VOICE` | OpenAI voice | `alloy` |
| `INSTRUCTIONS` | Bot instructions | Default instructions |

## Health Check

Railway automatically checks the `/health` endpoint:
- **Path:** `/health`
- **Timeout:** 100ms
- **Expected Response:** `{"status":"healthy","activeMeetings":0,"timestamp":"..."}`

## Monitoring

1. **View Logs:**
   - Go to your service → Deployments → Click on a deployment
   - View real-time logs in the Logs tab

2. **Metrics:**
   - Railway provides CPU, Memory, and Network metrics
   - Available in the Metrics tab

3. **Alerts:**
   - Set up alerts for deployment failures
   - Configure in Settings → Notifications

## Troubleshooting

### Build Fails

1. **Check Build Logs:**
   - Go to Deployments → Failed deployment → View logs
   - Look for npm install or Playwright installation errors

2. **Common Issues:**
   - **Out of memory:** Upgrade to a larger plan
   - **Playwright install fails:** Check `nixpacks.toml` configuration
   - **Missing dependencies:** Ensure all dependencies are in `package.json`

### Service Won't Start

1. **Check Runtime Logs:**
   - View logs in the Logs tab
   - Look for error messages

2. **Common Issues:**
   - **Port conflict:** Ensure `PORT` environment variable is set
   - **Missing env vars:** Check all required variables are set
   - **Health check failing:** Verify `/health` endpoint works

### Performance Issues

1. **Upgrade Plan:**
   - Railway offers different plan tiers
   - Upgrade if you need more CPU/Memory

2. **Optimize:**
   - Reduce `NAVIGATION_TIMEOUT_MS` if too high
   - Set `HEADLESS=true` for better performance
   - Monitor memory usage in Metrics tab

## Updating Backend Configuration

After deploying to Railway, update your backend's `BOT_SERVER_URL`:

```bash
BOT_SERVER_URL=https://your-service.railway.app
```

Or if Railway provides a custom domain:
```bash
BOT_SERVER_URL=https://your-custom-domain.railway.app
```

## Continuous Deployment

Railway automatically deploys when you push to your connected GitHub repository:
1. Push changes to your repo
2. Railway detects the push
3. Builds and deploys automatically
4. Updates your service with zero downtime

## Cost Considerations

- Railway offers a free tier with usage limits
- Pay-as-you-go pricing for additional usage
- Monitor usage in the Usage tab
- Consider upgrading plan for production workloads

## Support

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Railway Status: https://status.railway.app

