# Quick Deployment Guide

## Prerequisites

- EC2 instance launched and running
- SSH key pair (.pem file)
- EC2 instance public IP or DNS name

## Option 1: Automated Deployment Script (Recommended)

```bash
# From your local machine, in the browser_bot directory
cd browser_bot

# Run deployment script
./deploy-to-ec2.sh <ec2-ip-or-dns> <path-to-ssh-key>

# Example:
./deploy-to-ec2.sh ec2-54-123-45-67.compute-1.amazonaws.com ~/.ssh/my-key.pem
```

The script will:
1. Copy all application files to EC2
2. Install dependencies
3. Install Playwright Chromium
4. Create .env template (if needed)
5. Start the service

## Option 2: Manual Deployment

### Step 1: Copy Files to EC2

```bash
# From your local machine
cd browser_bot

# Copy files (excluding node_modules, .git, etc.)
scp -i ~/.ssh/your-key.pem -r \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'logs' \
    --exclude '*.log' \
    . ubuntu@your-ec2-ip:/tmp/browser_bot/
```

### Step 2: SSH and Setup

```bash
# SSH into EC2
ssh -i ~/.ssh/your-key.pem ubuntu@your-ec2-ip

# Move files to application directory
sudo rm -rf /opt/browser_bot/*
sudo mv /tmp/browser_bot/* /opt/browser_bot/
sudo chown -R botuser:botuser /opt/browser_bot

# Install dependencies
cd /opt/browser_bot
sudo -u botuser npm ci --only=production

# Install Playwright Chromium
sudo -u botuser npx playwright install chromium --with-deps
```

### Step 3: Configure Environment

```bash
# Create/edit .env file
sudo nano /opt/browser_bot/.env
```

Add your configuration:
```bash
PORT=3001
NODE_ENV=production
API_BASE_URL=https://api.auray.net
OPENAI_API_KEY=your-actual-openai-key-here
LOG_LEVEL=info
HEADLESS=true
SHOULD_SEND_STATUS=false
BROWSER_ENGINE=chromium
BROWSER_LOCALE=en-US
```

Save and set permissions:
```bash
sudo chown botuser:botuser /opt/browser_bot/.env
sudo chmod 600 /opt/browser_bot/.env
```

### Step 4: Start Service

```bash
# Reload systemd and start service
sudo systemctl daemon-reload
sudo systemctl start browser-bot
sudo systemctl enable browser-bot

# Check status
sudo systemctl status browser-bot

# View logs
sudo journalctl -u browser-bot -f
```

### Step 5: Verify Deployment

```bash
# Test health endpoint
curl http://localhost:3001/health

# Should return:
# {"status":"healthy","activeMeetings":0,"timestamp":"..."}
```

## Option 3: Deploy from Git (If using Git repository)

```bash
# SSH into EC2
ssh -i ~/.ssh/your-key.pem ubuntu@your-ec2-ip

# Clone repository
cd /opt/browser_bot
sudo -u botuser git clone https://github.com/Flave1/aurray_bot_crawler.git .

# Install dependencies
sudo -u botuser npm ci --only=production
sudo -u botuser npx playwright install chromium --with-deps

# Configure .env (see Step 3 above)
# Start service (see Step 4 above)
```

## Update Backend Configuration

After deployment, update your backend's environment:

```bash
BOT_SERVER_URL=http://your-ec2-ip-or-dns:3001
```

Or if using Elastic IP:
```bash
BOT_SERVER_URL=http://your-elastic-ip:3001
```

## Troubleshooting

### Service won't start
```bash
sudo systemctl status browser-bot
sudo journalctl -u browser-bot -n 50
```

### Port not accessible
```bash
# Check if service is running
sudo netstat -tlnp | grep 3001

# Check security group in AWS Console
# Ensure port 3001 is open
```

### Permission issues
```bash
sudo chown -R botuser:botuser /opt/browser_bot
```

### Playwright issues
```bash
cd /opt/browser_bot
sudo -u botuser npx playwright install chromium --with-deps
```

## Quick Commands Reference

```bash
# Start service
sudo systemctl start browser-bot

# Stop service
sudo systemctl stop browser-bot

# Restart service
sudo systemctl restart browser-bot

# View logs
sudo journalctl -u browser-bot -f

# View last 100 lines
sudo journalctl -u browser-bot -n 100

# Check status
sudo systemctl status browser-bot

# Test health
curl http://localhost:3001/health
```

