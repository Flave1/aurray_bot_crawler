# EC2 Security Group Configuration

## Required Rules for Browser Bot

### Rule 1: SSH Access (Port 22)
- **Type:** SSH
- **Protocol:** TCP
- **Port:** 22
- **Source:** Your IP address (recommended) or "My IP"
- **Description:** SSH access for management

**⚠️ Security Note:** Avoid using "Anywhere (0.0.0.0/0)" for SSH. Restrict to your IP or use a VPN.

### Rule 2: Browser Bot API (Port 3001)
- **Type:** Custom TCP
- **Protocol:** TCP
- **Port:** 3001
- **Source:** 
  - **Option A (Recommended):** Your backend's security group ID
  - **Option B:** Your backend's IP address
  - **Option C (Testing):** "My IP" or your specific IP
- **Description:** Browser Bot HTTP API

### Rule 3: Outbound (Default)
- All outbound traffic is allowed by default (needed for API calls, WebSocket connections)

## Step-by-Step in AWS Console

1. **In the Security Group configuration:**
   - Keep "Allow SSH traffic" checked
   - Change SSH source to "My IP" (or your specific IP)
   - Click "Add security group rule"

2. **Add Browser Bot Rule:**
   - **Type:** Custom TCP
   - **Port range:** 3001
   - **Source:** 
     - Select "Custom" and enter your backend's security group ID
     - OR select "My IP" for testing
   - **Description:** Browser Bot API

3. **Leave unchecked:**
   - Allow HTTPS traffic from the internet
   - Allow HTTP traffic from the internet

## Example Configuration

```
Inbound Rules:
┌──────────┬──────────┬──────────┬─────────────────────┐
│ Type     │ Protocol │ Port     │ Source              │
├──────────┼──────────┼──────────┼─────────────────────┤
│ SSH      │ TCP      │ 22       │ Your IP (x.x.x.x)  │
│ Custom   │ TCP      │ 3001     │ Backend SG or IP    │
└──────────┴──────────┴──────────┴─────────────────────┘
```

## Finding Your Backend Security Group

If your backend is on EC2/ECS:
1. Go to EC2 → Security Groups
2. Find your backend's security group
3. Copy the Security Group ID (e.g., `sg-0123456789abcdef0`)
4. Use this as the source for port 3001 rule

## Testing Access

After launching:
```bash
# Test from your backend server
curl http://your-ec2-ip:3001/health

# Should return:
# {"status":"healthy","activeMeetings":0,"timestamp":"..."}
```

