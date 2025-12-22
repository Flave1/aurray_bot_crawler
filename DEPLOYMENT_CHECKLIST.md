# EC2 Deployment Checklist

## Pre-Deployment

- [ ] AWS EC2 instance launched (Ubuntu 22.04 LTS)
- [ ] Security group configured (port 3001 open)
- [ ] SSH key pair ready
- [ ] EC2 instance has public IP or Elastic IP assigned

## Step 1: Launch EC2 Instance

1. Go to AWS Console → EC2 → Launch Instance
2. Choose Ubuntu 22.04 LTS AMI
3. Select instance type: **t3.medium** (minimum) or larger
4. Configure security group:
   - Inbound: Port 3001 from your backend IP/security group
   - Inbound: Port 22 (SSH) from your IP
5. In "Advanced details" → "User data", paste contents of `ec2-user-data.sh`
6. Launch instance

## Step 2: SSH and Deploy Code

```bash
# SSH into instance
ssh -i your-key.pem ubuntu@your-ec2-ip-or-dns

# Clone repository (or copy files)
cd /opt/browser_bot
sudo -u botuser git clone https://github.com/Flave1/aurray_bot_crawler.git .

# Install dependencies
cd /opt/browser_bot
sudo -u botuser npm ci --only=production
sudo -u botuser npx playwright install chromium --with-deps
```

## Step 3: Configure Environment

```bash
# Edit environment file
sudo nano /opt/browser_bot/.env
```

Required variables:
```bash
PORT=3001
API_BASE_URL=https://api.auray.net
OPENAI_API_KEY=your-actual-key-here
LOG_LEVEL=info
HEADLESS=true
```

## Step 4: Start Service

```bash
# Start the service
sudo systemctl start browser-bot

# Check status
sudo systemctl status browser-bot

# View logs
sudo journalctl -u browser-bot -f
```

## Step 5: Verify Deployment

```bash
# Test health endpoint
curl http://localhost:3001/health

# Should return:
# {"status":"healthy","activeMeetings":0,"timestamp":"..."}
```

## Step 6: Update Backend Configuration

Update your backend's environment variables:

```bash
BOT_SERVER_URL=http://your-ec2-ip-or-dns:3001
# or if using Elastic IP:
BOT_SERVER_URL=http://your-elastic-ip:3001
```

## Step 7: Test End-to-End

1. Start a meeting from your backend
2. Backend should call: `POST http://your-ec2-ip:3001/start-meeting`
3. Check bot logs: `sudo journalctl -u browser-bot -f`
4. Verify bot joins the meeting

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

# Check security group
# Ensure port 3001 is open in AWS Console
```

### Playwright issues
```bash
cd /opt/browser_bot
sudo -u botuser npx playwright install chromium --with-deps
```

## Next Steps After Deployment

- [ ] Set up CloudWatch monitoring (optional)
- [ ] Configure auto-scaling (if needed)
- [ ] Set up Application Load Balancer (for multiple instances)
- [ ] Configure automated backups
- [ ] Set up log aggregation

