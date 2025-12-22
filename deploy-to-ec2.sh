#!/bin/bash
# Deploy Browser Bot to EC2 Instance
# Usage: ./deploy-to-ec2.sh <ec2-ip-or-dns> <ssh-key-path>

set -e

if [ $# -lt 2 ]; then
    echo "Usage: $0 <ec2-ip-or-dns> <ssh-key-path>"
    echo "Example: $0 ec2-44-220-243-232.compute-1.amazonaws.com ~/.ssh/my-key.pem"
    exit 1
fi

EC2_HOST=$1
SSH_KEY=$2

if [ ! -f "$SSH_KEY" ]; then
    echo "❌ SSH key not found: $SSH_KEY"
    exit 1
fi

echo "========================================="
echo "Deploying Browser Bot to EC2"
echo "========================================="
echo "Target: $EC2_HOST"
echo ""

# Step 1: Copy files to EC2
echo "[1/4] Copying application files to EC2..."

# Create temporary directory and copy files (excluding unnecessary ones)
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Use rsync if available, otherwise tar
if command -v rsync &> /dev/null; then
    rsync -av --progress \
        --exclude 'node_modules' \
        --exclude '.git' \
        --exclude 'logs' \
        --exclude '*.log' \
        --exclude 'fake.y4m' \
        --exclude 'fake.wav' \
        --exclude '.DS_Store' \
        --exclude '__tests__' \
        --exclude '.env' \
        --exclude '*.pem' \
        --exclude 'keypair.pem' \
        --exclude '*.md' \
        --exclude 'deploy*.sh' \
        --exclude 'ec2-*.sh' \
        --exclude 'Dockerfile' \
        --exclude '.dockerignore' \
        --exclude 'EC2_*.md' \
        --exclude 'DEPLOYMENT_*.md' \
        --exclude 'QUICK_*.md' \
        --exclude 'SECURITY_*.md' \
        --exclude 'AUDIO_*.md' \
        --exclude 'scripts' \
        --exclude 'bot_entry.js' \
        ./ "$TEMP_DIR/browser_bot/"
else
    # Fallback: use tar with exclusions
    tar --exclude='node_modules' \
        --exclude='.git' \
        --exclude='logs' \
        --exclude='*.log' \
        --exclude='fake.y4m' \
        --exclude='fake.wav' \
        --exclude='.DS_Store' \
        --exclude='__tests__' \
        --exclude='.env' \
        --exclude='*.pem' \
        --exclude='keypair.pem' \
        --exclude='*.md' \
        --exclude='deploy*.sh' \
        --exclude='ec2-*.sh' \
        --exclude='Dockerfile' \
        --exclude='.dockerignore' \
        --exclude='EC2_*.md' \
        --exclude='DEPLOYMENT_*.md' \
        --exclude='QUICK_*.md' \
        --exclude='SECURITY_*.md' \
        --exclude='AUDIO_*.md' \
        --exclude='scripts' \
        --exclude='bot_entry.js' \
        -czf "$TEMP_DIR/browser_bot.tar.gz" .
    mkdir -p "$TEMP_DIR/browser_bot"
    tar -xzf "$TEMP_DIR/browser_bot.tar.gz" -C "$TEMP_DIR/browser_bot"
fi

# Copy to EC2 (disable host key checking for first connection)
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -r "$TEMP_DIR/browser_bot" ubuntu@$EC2_HOST:/tmp/

echo "✅ Files copied"

# Step 2: SSH and setup
echo "[2/4] Setting up application on EC2..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@$EC2_HOST << 'ENDSSH'
    set -e
    
    # Install Node.js if not present
    if ! command -v node &> /dev/null; then
        echo "Installing Node.js 18.x..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    
    # Install system dependencies for Playwright
    echo "Installing system dependencies..."
    sudo apt-get update
    sudo apt-get install -y \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
        fonts-liberation libappindicator3-1 xdg-utils || true
    
    # Create botuser if it doesn't exist
    if ! id -u botuser > /dev/null 2>&1; then
        echo "Creating botuser..."
        sudo useradd -r -s /bin/bash botuser || true
    fi
    
    # Create application directory (not as home directory)
    sudo mkdir -p /opt/browser_bot
    sudo chown -R botuser:botuser /opt/browser_bot
    
    # Move files to application directory (clean removal first)
    sudo find /opt/browser_bot -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} + 2>/dev/null || true
    sudo mv /tmp/browser_bot/* /opt/browser_bot/ 2>/dev/null || true
    sudo mv /tmp/browser_bot/.* /opt/browser_bot/ 2>/dev/null || true
    sudo chown -R botuser:botuser /opt/browser_bot
    
    # Create logs directory
    sudo mkdir -p /opt/browser_bot/logs/screenshots
    sudo chown -R botuser:botuser /opt/browser_bot/logs
    
    # Install dependencies
    echo "Installing Node.js dependencies..."
    sudo -u botuser bash -c "cd /opt/browser_bot && npm ci --only=production"
    
    # Install Playwright Chromium
    echo "Installing Playwright Chromium..."
    sudo -u botuser bash -c "cd /opt/browser_bot && npx playwright install chromium --with-deps" || sudo -u botuser bash -c "cd /opt/browser_bot && npx playwright install chromium"
    
    echo "✅ Dependencies installed"
ENDSSH

echo "✅ Application setup complete"

# Step 3: Check if .env exists
echo "[3/4] Checking environment configuration..."
ENV_EXISTS=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@$EC2_HOST "test -f /opt/browser_bot/.env && echo 'yes' || echo 'no'")

if [ "$ENV_EXISTS" = "no" ]; then
    echo "⚠️  .env file not found. Creating template..."
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@$EC2_HOST << 'ENDSSH'
        cat > /tmp/.env << 'EOF'
PORT=3001
NODE_ENV=production
API_BASE_URL=https://api.auray.net
OPENAI_API_KEY=your-openai-api-key-here
LOG_LEVEL=info
HEADLESS=true
SHOULD_SEND_STATUS=false
BROWSER_ENGINE=chromium
BROWSER_LOCALE=en-US
EOF
        sudo mv /tmp/.env /opt/browser_bot/.env
        sudo chown botuser:botuser /opt/browser_bot/.env
        sudo chmod 600 /opt/browser_bot/.env
        echo "⚠️  Please update /opt/browser_bot/.env with your actual values"
ENDSSH
else
    echo "✅ .env file exists"
fi

# Step 4: Start service
echo "[4/4] Starting browser bot service..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@$EC2_HOST << 'ENDSSH'
    # Install systemd service if not already installed
    if [ ! -f /etc/systemd/system/browser-bot.service ]; then
        echo "Installing systemd service..."
        sudo cp /opt/browser_bot/browser-bot.service /etc/systemd/system/ 2>/dev/null || {
            # Create service file if it doesn't exist
            sudo tee /etc/systemd/system/browser-bot.service > /dev/null << 'EOFSERVICE'
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

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/browser_bot/logs

LimitNOFILE=65536
MemoryMax=4G

[Install]
WantedBy=multi-user.target
EOFSERVICE
        }
    fi
    
    sudo systemctl daemon-reload
    sudo systemctl enable browser-bot
    sudo systemctl restart browser-bot
    sleep 2
    sudo systemctl status browser-bot --no-pager
ENDSSH

echo ""
echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Update /opt/browser_bot/.env with your API keys:"
echo "   ssh -i $SSH_KEY ubuntu@$EC2_HOST"
echo "   sudo nano /opt/browser_bot/.env"
echo ""
echo "2. Restart service after updating .env:"
echo "   sudo systemctl restart browser-bot"
echo ""
echo "3. Check service status:"
echo "   sudo systemctl status browser-bot"
echo ""
echo "4. View logs:"
echo "   sudo journalctl -u browser-bot -f"
echo ""
echo "5. Test health endpoint:"
echo "   curl http://$EC2_HOST:3001/health"
echo ""

