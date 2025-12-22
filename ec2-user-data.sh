#!/bin/bash
# EC2 User Data Script for Browser Bot
# This script runs when the EC2 instance first launches

set -e

# Log everything
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "========================================="
echo "Browser Bot EC2 User Data Script"
echo "Started at: $(date)"
echo "========================================="

# Update system
apt-get update
apt-get upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Install system dependencies for Playwright
apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    curl \
    git \
    unzip

# Create application user
useradd -r -s /bin/bash -m -d /opt/browser_bot botuser || true

# Create application directory
mkdir -p /opt/browser_bot
chown botuser:botuser /opt/browser_bot

# Create logs directory
mkdir -p /opt/browser_bot/logs/screenshots
chown -R botuser:botuser /opt/browser_bot/logs

# Clone repository (if using Git)
# Uncomment and modify if deploying from Git:
# cd /opt/browser_bot
# sudo -u botuser git clone https://github.com/your-org/aurray_bot_crawler.git .
# cd /opt/browser_bot
# sudo -u botuser npm ci --only=production
# sudo -u botuser npx playwright install chromium --with-deps

# Install systemd service
cat > /etc/systemd/system/browser-bot.service << 'EOF'
[Unit]
Description=Browser Bot Service
After=network.target

[Service]
Type=simple
User=botuser
WorkingDirectory=/opt/browser_bot
Environment="NODE_ENV=production"
EnvironmentFile=/opt/browser_bot/.env
ExecStart=/usr/bin/node /opt/browser_bot/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=browser-bot

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/browser_bot/logs

# Resource limits
LimitNOFILE=65536
MemoryMax=4G

[Install]
WantedBy=multi-user.target
EOF

# Create .env file template (user should update with actual values)
cat > /opt/browser_bot/.env << 'EOF'
# Browser Bot Configuration
PORT=3001
NODE_ENV=production

# Backend API
API_BASE_URL=https://api.auray.net

# OpenAI
OPENAI_API_KEY=your-openai-api-key-here

# Optional Configuration
LOG_LEVEL=info
HEADLESS=true
SHOULD_SEND_STATUS=false
BROWSER_ENGINE=chromium
BROWSER_LOCALE=en-US
EOF

chown botuser:botuser /opt/browser_bot/.env
chmod 600 /opt/browser_bot/.env

# Reload systemd
systemctl daemon-reload

# Enable service (but don't start yet - wait for app files)
systemctl enable browser-bot.service

echo ""
echo "========================================="
echo "✅ User data script completed!"
echo "========================================="
echo ""
echo "IMPORTANT: Before starting the service:"
echo "1. Copy your application files to /opt/browser_bot"
echo "2. Update /opt/browser_bot/.env with your actual values"
echo "3. Run: cd /opt/browser_bot && npm ci --only=production"
echo "4. Run: npx playwright install chromium --with-deps"
echo "5. Start service: sudo systemctl start browser-bot"
echo ""
echo "Check logs: sudo journalctl -u browser-bot -f"
echo ""

