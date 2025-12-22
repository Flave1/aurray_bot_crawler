#!/bin/bash
set -e

echo "========================================="
echo "Browser Bot EC2 Setup Script"
echo "========================================="

# Update system
echo "[1/7] Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# Install Node.js 18.x
echo "[2/7] Installing Node.js 18.x..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify Node.js installation
node_version=$(node --version)
npm_version=$(npm --version)
echo "✅ Node.js installed: $node_version"
echo "✅ npm installed: $npm_version"

# Install system dependencies for Playwright
echo "[3/7] Installing system dependencies for Playwright..."
sudo apt-get install -y \
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
    curl

# Create application user
echo "[4/7] Creating application user..."
if ! id -u botuser > /dev/null 2>&1; then
    sudo useradd -r -s /bin/bash -m -d /opt/browser_bot botuser
    echo "✅ Created user: botuser"
else
    echo "✅ User botuser already exists"
fi

# Create application directory
echo "[5/7] Setting up application directory..."
sudo mkdir -p /opt/browser_bot
sudo chown botuser:botuser /opt/browser_bot

# Install application dependencies (if package.json exists)
if [ -f "/opt/browser_bot/package.json" ]; then
    echo "[6/7] Installing Node.js dependencies..."
    cd /opt/browser_bot
    sudo -u botuser npm ci --only=production
    
    echo "[7/7] Installing Playwright Chromium..."
    sudo -u botuser npx playwright install chromium --with-deps || sudo -u botuser npx playwright install chromium
else
    echo "[6/7] Skipping dependency installation (package.json not found)"
    echo "[7/7] Skipping Playwright installation"
fi

# Create logs directory
sudo mkdir -p /opt/browser_bot/logs/screenshots
sudo chown -R botuser:botuser /opt/browser_bot/logs

echo ""
echo "========================================="
echo "✅ Setup complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Copy your application files to /opt/browser_bot"
echo "2. Set up environment variables in /opt/browser_bot/.env"
echo "3. Install the systemd service: sudo cp browser-bot.service /etc/systemd/system/"
echo "4. Enable and start: sudo systemctl enable browser-bot && sudo systemctl start browser-bot"
echo ""

