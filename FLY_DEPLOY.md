# Fly.io Deployment Guide for Browser Bot

This guide will help you deploy the browser bot to Fly.io.

## Prerequisites

1. **Fly.io Account**: Sign up at [fly.io](https://fly.io) (free tier available)
2. **Fly CLI**: Install the Fly CLI tool
   ```bash
   # macOS
   curl -L https://fly.io/install.sh | sh
   
   # Or using Homebrew
   brew install flyctl
   
   # Linux
   curl -L https://fly.io/install.sh | sh
   
   # Windows (PowerShell)
   powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
   ```

3. **Login to Fly.io**:
   ```bash
   fly auth login
   ```

## Initial Setup

1. **Navigate to browser_bot directory**:
   ```bash
   cd browser_bot
   ```

2. **Create/Launch the app** (first time only):
   ```bash
   fly launch
   ```
   
   This will:
   - Detect your Dockerfile
   - Ask for app name (or use the one in fly.toml)
   - Ask if you want to deploy now (say no for now)
   - Create the app on Fly.io

3. **Configure the app name** (if you want to change it):
   ```bash
   # Edit fly.toml and change the "app" field
   # Or set it via CLI:
   fly apps create aurray-bot-staging  # or your preferred name
   ```

## Environment Variables

Set your environment variables on Fly.io:

```bash
# Required variables
fly secrets set API_BASE_URL=https://api.auray.net
fly secrets set OPENAI_API_KEY=your_openai_key
fly secrets set OPENAI_REALTIME_WS_URL=wss://api.openai.com/v1/realtime

# Optional variables
fly secrets set LOG_LEVEL=info
fly secrets set HEADLESS=true
fly secrets set BROWSER_ENGINE=chromium
fly secrets set BROWSER_LOCALE=en-US
```

**Note**: Secrets are encrypted and only available at runtime. For non-sensitive config, you can add them to `fly.toml` under `[env]` section.

## Deployment

1. **Deploy the app**:
   ```bash
   fly deploy
   ```

2. **Monitor the deployment**:
   ```bash
   fly logs
   ```

3. **Check app status**:
   ```bash
   fly status
   ```

4. **View app info**:
   ```bash
   fly info
   ```

## Managing the App

### View Logs
```bash
fly logs
# Or follow logs in real-time
fly logs -a aurray-bot
```

### SSH into the VM
```bash
fly ssh console
```

### Scale the App
```bash
# Scale to 2 instances
fly scale count 2

# Scale memory
fly scale memory 4096

# Scale CPU
fly scale vm shared-cpu-4
```

### Restart the App
```bash
fly apps restart aurray-bot
```

### View Metrics
```bash
fly metrics
```

## Health Check

The app includes a health check endpoint at `/health`. Fly.io will automatically monitor this.

Test it manually:
```bash
curl https://aurray-bot.fly.dev/health
```

## Updating the App

1. **Make your changes**
2. **Deploy**:
   ```bash
   fly deploy
   ```

## Getting the App URL

After deployment, get your app URL:
```bash
fly info
```

Or check the dashboard at https://fly.io/dashboard

## Backend Configuration

Update your backend's `BOT_SERVER_URL` to point to your Fly.io app:

```bash
# Example
BOT_SERVER_URL=https://aurray-bot.fly.dev
```

## Troubleshooting

### Check if app is running
```bash
fly status
```

### View recent logs
```bash
fly logs --recent
```

### SSH and inspect
```bash
fly ssh console
# Then inside the VM:
# ls -la
# ps aux
# cat /app/server.js
```

### Restart if needed
```bash
fly apps restart aurray-bot
```

### Check resource usage
```bash
fly metrics
```

### View app configuration
```bash
fly config show
```

## Cost Considerations

- **Free tier**: 3 shared-cpu-1x256 VMs
- **Paid plans**: Start at ~$1.94/month per VM
- **Current config**: 1 VM with 2 CPUs and 2GB RAM (~$3.88/month)

To reduce costs, you can:
- Use smaller VM size (shared-cpu-1x512)
- Enable auto-scaling to 0 when idle
- Use single region deployment

## Auto-scaling Configuration

To enable auto-scaling (scale to 0 when idle):

Edit `fly.toml`:
```toml
[http_service]
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0  # Allow scaling to 0
```

## Multiple Regions

To deploy to multiple regions:
```bash
fly regions add iad ord dfw  # Add regions
fly scale count 2  # Scale to 2 instances
```

## Need Help?

- Fly.io Docs: https://fly.io/docs
- Fly.io Community: https://community.fly.io
- Support: support@fly.io

