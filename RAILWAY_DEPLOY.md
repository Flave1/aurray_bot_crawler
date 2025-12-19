# Railway Deployment Guide for Browser Bot

This guide covers deploying the browser bot to Railway **without Docker**. Railway uses Nixpacks to automatically build and deploy Node.js applications.

## Prerequisites

1. Railway account: https://railway.app (sign up with GitHub)
2. Railway CLI (optional, for local deployment): `npm i -g @railway/cli`

## Quick Start

### Option 1: Deploy via Railway Dashboard (Recommended)

1. **Sign up/Login to Railway**
   - Go to https://railway.app
   - Sign in with your GitHub account

2. **Create New Project**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository
   - **IMPORTANT**: After the service is created, go to **Settings → Root Directory** and set it to `browser_bot`
   - This tells Railway to use `browser_bot` as the root directory (not the repo root)
   - Railway will automatically detect Node.js and use `nixpacks.toml` for the build

3. **Configure Environment Variables**
   In Railway dashboard, go to your service → Variables tab:
   
   **Required:**
   ```
   API_BASE_URL=https://your-backend-api.com
   OPENAI_API_KEY=sk-proj-...
   ```
   
   **Optional:**
   ```
   LOG_LEVEL=info
   HEADLESS=true
   SHOULD_SEND_STATUS=false
   PORT=3001
   ```

4. **Deploy**
   - Railway will automatically detect the Node.js app
   - It will run `npm install` and `npx playwright install chromium`
   - The app will be deployed automatically

5. **Get Your URL**
   - Railway provides a public URL automatically
   - Go to Settings → Networking to configure custom domain

### Option 2: Deploy via Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Link to existing project (or create new)
railway link

# Set environment variables
railway variables set API_BASE_URL=https://your-backend-api.com
railway variables set OPENAI_API_KEY=sk-proj-...

# Deploy
railway up
```

## Important Notes

### Port Configuration
Railway automatically sets `PORT` environment variable. The app already uses `process.env.PORT || 3001`, so no changes needed.

### Playwright Installation
Railway will automatically install Playwright browsers during build. The `postinstall` script in `package.json` handles this.

### System Dependencies
Railway's Nixpacks builder automatically detects and installs system dependencies for Playwright. No additional configuration needed.

### Resource Limits
- Free tier: 512MB RAM, $5 credit/month
- Hobby plan: $5/month, 1GB RAM
- Pro plan: $20/month, 8GB RAM

For multiple concurrent bots, consider upgrading to Hobby or Pro.

### Environment Variables
Set these in Railway dashboard (Settings → Variables):

**Required:**
- `API_BASE_URL` - Your backend API URL
- `OPENAI_API_KEY` - OpenAI API key

**Optional:**
- `OPENAI_REALTIME_WS_URL` - WebSocket URL (if not provided, bot fetches token)
- `LOG_LEVEL` - Logging level (default: `info`)
- `HEADLESS` - Headless mode (default: `true`)
- `SHOULD_SEND_STATUS` - Send status updates (default: `false`)
- `BROWSER_ENGINE` - Browser engine (default: `chromium`)
- `BROWSER_LOCALE` - Browser locale (default: `en-US`)

## Monitoring

### View Logs
```bash
# Via CLI
railway logs

# Or in Railway dashboard
# Go to your service → Logs tab
```

### Check Status
```bash
railway status
```

### View Metrics
- Go to Railway dashboard → Your service → Metrics
- View CPU, Memory, Network usage

## API Endpoints

Once deployed, your bot server will be available at:
- `https://your-app-name.up.railway.app`

Endpoints:
- `GET /health` - Health check
- `POST /start-meeting` - Start a new meeting bot
- `DELETE /stop-meeting/:meetingId` - Stop a meeting bot
- `GET /meetings` - List active meetings
- `GET /meetings/:meetingId` - Get meeting status
- `GET /meetings/:meetingId/logs` - Get meeting logs

## Custom Domain

1. Go to Settings → Networking
2. Click "Generate Domain" or add custom domain
3. Railway provides SSL automatically

## Troubleshooting

### "Cannot find module '/app/server.js'" Error
**This means Railway is deploying from the wrong directory.**

**Solution:**
1. Go to Railway dashboard → Your service → **Settings**
2. Find **"Root Directory"** setting
3. Set it to: `browser_bot`
4. Click **"Redeploy"** or push a new commit

This tells Railway to use the `browser_bot` directory as the root, so it will find `server.js` at the correct path.

### Build Fails
- Check logs in Railway dashboard
- Ensure `package.json` has correct scripts
- Verify Playwright installation in build logs

### Playwright Browser Not Found
- Check build logs for Playwright installation
- Verify `postinstall` script runs successfully
- Try setting `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0`

### Memory Issues
- Upgrade to Hobby or Pro plan
- Reduce concurrent bot instances
- Monitor memory usage in Metrics tab

### Port Issues
- Railway sets `PORT` automatically
- Ensure app listens on `process.env.PORT`

## Updating the App

Railway automatically deploys on every push to your connected branch:

```bash
git add .
git commit -m "Update bot"
git push
```

Or manually trigger deployment in Railway dashboard.

## Cost Estimation

- **Free tier**: $5 credit/month (usually enough for light usage)
- **Hobby**: $5/month (1GB RAM, good for moderate usage)
- **Pro**: $20/month (8GB RAM, good for production)

## Comparison with Heroku

| Feature | Railway | Heroku |
|---------|---------|--------|
| Free Tier | ✅ $5 credit/month | ❌ Discontinued |
| Credit Card | ❌ Not required | ✅ Required |
| Docker Support | ✅ Excellent | ⚠️ Limited |
| GitHub Integration | ✅ Native | ✅ Native |
| Ease of Use | ✅ Very Easy | ⚠️ Moderate |
| Pricing | 💰 Pay-as-you-go | 💰 Fixed plans |

