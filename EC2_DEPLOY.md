# EC2 Deployment Guide for Browser Bot

This guide covers deploying the browser bot to AWS EC2.

## Prerequisites

1. AWS EC2 instance (Ubuntu 22.04 LTS recommended)
2. Security group with inbound rules:
   - Port 3001 (or your chosen PORT) from your backend/load balancer
   - SSH (port 22) for management
3. IAM role with necessary permissions (if using AWS services)

## Quick Setup

### Option 1: Using User Data Script (Recommended for new instances)

1. **Launch EC2 Instance:**
   - Choose Ubuntu 22.04 LTS AMI
   - Select instance type (t3.medium or larger recommended)
   - Configure security group (open port 3001)
   - In "Advanced details" → "User data", paste contents of `ec2-user-data.sh`

2. **After instance launches:**
   ```bash
   # SSH into instance
   ssh -i your-key.pem ubuntu@your-ec2-ip
   
   # Copy application files
   # Option A: Clone from Git
   cd /opt/browser_bot
   sudo -u botuser git clone https://github.com/your-org/aurray_bot_crawler.git .
   
   # Option B: Copy files via SCP
   # scp -r browser_bot/* ubuntu@your-ec2-ip:/tmp/
   # sudo mv /tmp/* /opt/browser_bot/
   # sudo chown -R botuser:botuser /opt/browser_bot
   
   # Install dependencies
   cd /opt/browser_bot
   sudo -u botuser npm ci --only=production
   sudo -u botuser npx playwright install chromium --with-deps
   
   # Update environment variables
   sudo nano /opt/browser_bot/.env
   
   # Start service
   sudo systemctl start browser-bot
   sudo systemctl status browser-bot
   ```

### Option 2: Manual Setup on Existing Instance

1. **Run setup script:**
   ```bash
   # Copy setup script to instance
   scp browser_bot/ec2-setup.sh ubuntu@your-ec2-ip:/tmp/
   
   # SSH and run
   ssh ubuntu@your-ec2-ip
   chmod +x /tmp/ec2-setup.sh
   sudo /tmp/ec2-setup.sh
   ```

2. **Copy application files:**
   ```bash
   # From your local machine
   scp -r browser_bot/* ubuntu@your-ec2-ip:/tmp/browser_bot/
   
   # On EC2 instance
   sudo mv /tmp/browser_bot/* /opt/browser_bot/
   sudo chown -R botuser:botuser /opt/browser_bot
   ```

3. **Install dependencies:**
   ```bash
   cd /opt/browser_bot
   sudo -u botuser npm ci --only=production
   sudo -u botuser npx playwright install chromium --with-deps
   ```

4. **Install systemd service:**
   ```bash
   sudo cp browser-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable browser-bot
   ```

5. **Configure environment:**
   ```bash
   sudo nano /opt/browser_bot/.env
   # Add your environment variables (see below)
   ```

6. **Start service:**
   ```bash
   sudo systemctl start browser-bot
   sudo systemctl status browser-bot
   ```

## Environment Variables

Create `/opt/browser_bot/.env` with the following:

```bash
# Server Configuration
PORT=3001
NODE_ENV=production

# Backend API
API_BASE_URL=https://api.auray.net

# OpenAI
OPENAI_API_KEY=sk-proj-your-key-here

# Optional Configuration
LOG_LEVEL=info
HEADLESS=true
SHOULD_SEND_STATUS=false
BROWSER_ENGINE=chromium
BROWSER_LOCALE=en-US
NAVIGATION_TIMEOUT_MS=45000
```

## Service Management

```bash
# Start service
sudo systemctl start browser-bot

# Stop service
sudo systemctl stop browser-bot

# Restart service
sudo systemctl restart browser-bot

# Check status
sudo systemctl status browser-bot

# View logs
sudo journalctl -u browser-bot -f

# View last 100 lines
sudo journalctl -u browser-bot -n 100
```

## Health Check

The service exposes a health endpoint:

```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "healthy",
  "activeMeetings": 0,
  "timestamp": "2024-12-20T14:30:00.000Z"
}
```

## Updating the Application

1. **Stop service:**
   ```bash
   sudo systemctl stop browser-bot
   ```

2. **Update files:**
   ```bash
   cd /opt/browser_bot
   # Option A: Git pull
   sudo -u botuser git pull
   
   # Option B: Copy new files
   # scp new files and replace
   ```

3. **Update dependencies (if needed):**
   ```bash
   sudo -u botuser npm ci --only=production
   ```

4. **Start service:**
   ```bash
   sudo systemctl start browser-bot
   ```

## Security Group Configuration

Your EC2 security group should allow:

- **Inbound:**
  - Port 3001 from your backend/load balancer IP or security group
  - Port 22 (SSH) from your management IP

- **Outbound:**
  - All traffic (for API calls, WebSocket connections, etc.)

## Backend Configuration

Update your backend's `BOT_SERVER_URL` to point to your EC2 instance:

```bash
BOT_SERVER_URL=http://your-ec2-ip-or-dns:3001
# or if using a load balancer:
BOT_SERVER_URL=http://your-load-balancer-dns:3001
```

## Troubleshooting

### Service won't start

```bash
# Check service status
sudo systemctl status browser-bot

# Check logs
sudo journalctl -u browser-bot -n 50

# Check if port is in use
sudo netstat -tlnp | grep 3001

# Check permissions
ls -la /opt/browser_bot
```

### Playwright/Chromium issues

```bash
# Reinstall Playwright
cd /opt/browser_bot
sudo -u botuser npx playwright install chromium --with-deps

# Check Chromium installation
sudo -u botuser npx playwright install-deps chromium
```

### High memory usage

The service is configured with a 4GB memory limit. If you need more:

```bash
sudo nano /etc/systemd/system/browser-bot.service
# Update MemoryMax=4G to desired value
sudo systemctl daemon-reload
sudo systemctl restart browser-bot
```

### Connection issues

```bash
# Test connectivity from backend
curl http://your-ec2-ip:3001/health

# Check firewall
sudo ufw status
sudo ufw allow 3001/tcp
```

## Monitoring

### CloudWatch Logs (Optional)

To send logs to CloudWatch:

1. Install CloudWatch agent
2. Configure log group
3. Update systemd service to output to CloudWatch

### Health Check Monitoring

Set up a health check endpoint monitor that calls:
```
GET http://your-ec2-ip:3001/health
```

## Scaling

For multiple instances:

1. Use an Application Load Balancer (ALB)
2. Create multiple EC2 instances
3. Register instances with ALB target group
4. Update backend `BOT_SERVER_URL` to point to ALB

## Cost Optimization

- Use Spot Instances for non-critical workloads
- Use t3.medium or t3.large for most use cases
- Monitor CloudWatch metrics for right-sizing
- Consider Reserved Instances for predictable workloads

