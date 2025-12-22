#!/bin/bash
# Browser Bot EC2 Deployment Script
# Usage: ./deploy.sh

set -e

# ============================================================================
# CONFIGURATION - UPDATE THESE VALUES
# ============================================================================

# Your EC2 instance details
EC2_HOST="${EC2_HOST:-}"  # e.g., "ec2-54-123-45-67.compute-1.amazonaws.com" or "3.123.45.67"
SSH_KEY="${SSH_KEY:-}"     # e.g., "~/.ssh/my-key.pem" or "/path/to/key.pem"

# Environment variables for the bot
API_BASE_URL="${API_BASE_URL:-https://api.auray.net}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"

# ============================================================================
# VALIDATION
# ============================================================================

if [ -z "$EC2_HOST" ]; then
    echo "❌ Error: EC2_HOST not set"
    echo ""
    echo "Usage:"
    echo "  export EC2_HOST=your-ec2-ip-or-dns"
    echo "  export SSH_KEY=path/to/your-key.pem"
    echo "  ./deploy.sh"
    echo ""
    echo "Or set them inline:"
    echo "  EC2_HOST=your-ec2-ip SSH_KEY=path/to/key.pem ./deploy.sh"
    exit 1
fi

if [ -z "$SSH_KEY" ]; then
    echo "❌ Error: SSH_KEY not set"
    echo ""
    echo "Usage:"
    echo "  export SSH_KEY=path/to/your-key.pem"
    echo "  ./deploy.sh"
    exit 1
fi

# Expand ~ in SSH_KEY path
SSH_KEY=$(eval echo "$SSH_KEY")

if [ ! -f "$SSH_KEY" ]; then
    echo "❌ Error: SSH key not found: $SSH_KEY"
    exit 1
fi

# Make key readable only by owner
chmod 400 "$SSH_KEY" 2>/dev/null || true

echo "========================================="
echo "Browser Bot EC2 Deployment"
echo "========================================="
echo "Target: $EC2_HOST"
echo "SSH Key: $SSH_KEY"
echo ""

# ============================================================================
# STEP 1: Copy Files
# ============================================================================

echo "[1/5] Copying application files to EC2..."

# Create a temporary directory with files to copy
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Copy files excluding unnecessary ones
rsync -av --progress \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'logs' \
    --exclude '*.log' \
    --exclude 'google_auth_state*.json' \
    --exclude 'fake.y4m' \
    --exclude 'fake.wav' \
    --exclude '.DS_Store' \
    --exclude '__tests__' \
    --exclude '.env' \
    ./ "$TEMP_DIR/browser_bot/"

# Copy to EC2
scp -i "$SSH_KEY" -r "$TEMP_DIR/browser_bot" ubuntu@$EC2_HOST:/tmp/

echo "✅ Files copied"

# ============================================================================
# STEP 2: Setup on EC2
# ============================================================================

echo "[2/5] Setting up application on EC2..."

ssh -i "$SSH_KEY" ubuntu@$EC2_HOST << ENDSSH
    set -e
    
    # Move files to application directory
    echo "Moving files to /opt/browser_bot..."
    sudo rm -rf /opt/browser_bot/*
    sudo mv /tmp/browser_bot/* /opt/browser_bot/ 2>/dev/null || true
    sudo chown -R botuser:botuser /opt/browser_bot
    
    # Install dependencies
    echo "Installing Node.js dependencies..."
    cd /opt/browser_bot
    sudo -u botuser npm ci --only=production
    
    # Install Playwright Chromium
    echo "Installing Playwright Chromium..."
    sudo -u botuser npx playwright install chromium --with-deps || sudo -u botuser npx playwright install chromium
    
    echo "✅ Dependencies installed"
ENDSSH

echo "✅ Application setup complete"

# ============================================================================
# STEP 3: Configure Environment
# ============================================================================

echo "[3/5] Configuring environment..."

if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  Warning: OPENAI_API_KEY not set. You'll need to update .env manually."
fi

ssh -i "$SSH_KEY" ubuntu@$EC2_HOST << ENDSSH
    # Create .env file
    cat > /tmp/.env << EOF
PORT=3001
NODE_ENV=production
API_BASE_URL=${API_BASE_URL}
OPENAI_API_KEY=${OPENAI_API_KEY}
LOG_LEVEL=info
HEADLESS=true
SHOULD_SEND_STATUS=false
BROWSER_ENGINE=chromium
BROWSER_LOCALE=en-US
NAVIGATION_TIMEOUT_MS=45000
EOF
    
    sudo mv /tmp/.env /opt/browser_bot/.env
    sudo chown botuser:botuser /opt/browser_bot/.env
    sudo chmod 600 /opt/browser_bot/.env
    
    if [ -z "${OPENAI_API_KEY}" ]; then
        echo "⚠️  Please update /opt/browser_bot/.env with your OPENAI_API_KEY"
    fi
ENDSSH

echo "✅ Environment configured"

# ============================================================================
# STEP 4: Install Systemd Service
# ============================================================================

echo "[4/5] Installing systemd service..."

# Copy service file
scp -i "$SSH_KEY" browser-bot.service ubuntu@$EC2_HOST:/tmp/

ssh -i "$SSH_KEY" ubuntu@$EC2_HOST << 'ENDSSH'
    sudo cp /tmp/browser-bot.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable browser-bot
    echo "✅ Service installed and enabled"
ENDSSH

echo "✅ Systemd service installed"

# ============================================================================
# STEP 5: Start Service
# ============================================================================

echo "[5/5] Starting browser bot service..."

ssh -i "$SSH_KEY" ubuntu@$EC2_HOST << 'ENDSSH'
    sudo systemctl restart browser-bot
    sleep 3
    
    # Check status
    if sudo systemctl is-active --quiet browser-bot; then
        echo "✅ Service is running"
        sudo systemctl status browser-bot --no-pager -l | head -20
    else
        echo "❌ Service failed to start"
        sudo systemctl status browser-bot --no-pager -l
        exit 1
    fi
ENDSSH

echo ""
echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo ""
echo "Service Status:"
ssh -i "$SSH_KEY" ubuntu@$EC2_HOST "sudo systemctl is-active browser-bot && echo '✅ Running' || echo '❌ Not running'"

echo ""
echo "Health Check:"
HEALTH=$(ssh -i "$SSH_KEY" ubuntu@$EC2_HOST "curl -s http://localhost:3001/health 2>/dev/null || echo 'failed'")
if [ "$HEALTH" != "failed" ]; then
    echo "✅ Health endpoint responding:"
    echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
else
    echo "⚠️  Health check failed - service may still be starting"
fi

echo ""
echo "Next Steps:"
echo "1. If OPENAI_API_KEY wasn't set, update it:"
echo "   ssh -i $SSH_KEY ubuntu@$EC2_HOST"
echo "   sudo nano /opt/browser_bot/.env"
echo "   sudo systemctl restart browser-bot"
echo ""
echo "2. Update backend BOT_SERVER_URL:"
echo "   BOT_SERVER_URL=http://$EC2_HOST:3001"
echo ""
echo "3. View logs:"
echo "   ssh -i $SSH_KEY ubuntu@$EC2_HOST"
echo "   sudo journalctl -u browser-bot -f"
echo ""
echo "4. Test from backend:"
echo "   curl http://$EC2_HOST:3001/health"
echo ""

