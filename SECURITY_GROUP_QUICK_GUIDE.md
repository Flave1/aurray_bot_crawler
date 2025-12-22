# Security Group Configuration - Quick Guide

## Current Setup (What You See)

✅ **Rule 1:** SSH (port 22) from 0.0.0.0/0
✅ **Rule 2:** Custom TCP (port 3001) - **NEEDS SOURCE CONFIGURED**

## Step-by-Step Instructions

### Step 1: Configure Port 3001 Source

1. In **"Security group rule 2 (TCP, 3001)"**:
   - Click the **"Source"** search field (currently empty)
   
2. Choose one option:

   **Option A - For Testing (Quick):**
   - Type: `My IP`
   - Select it from dropdown
   - This automatically uses your current IP
   
   **Option B - For Production (Recommended):**
   - Type your backend's security group ID: `sg-xxxxxxxxx`
   - OR type your backend's IP: `x.x.x.x/32`
   - Select it
   
3. Add description:
   - In **"Description - optional"** field
   - Type: `Browser Bot API` or `Bot server port 3001`

### Step 2: Secure SSH (Optional but Recommended)

1. In **"Security group rule 1 (TCP, 22)"**:
   - Change **"Source type"** dropdown from `Anywhere` to `My IP`
   - OR select `Custom` and enter your IP: `x.x.x.x/32`

### Step 3: Review

Your final rules should look like:

```
Rule 1: SSH (22) from My IP
Rule 2: Custom TCP (3001) from [Your Backend IP/SG]
```

### Step 4: Continue

Click **"Continue"** or **"Launch instance"** to proceed.

## Finding Your Backend Security Group ID

If your backend is on AWS:

```bash
# Using AWS CLI
aws ec2 describe-security-groups --query 'SecurityGroups[?GroupName==`your-backend-sg-name`].GroupId' --output text

# Or check in AWS Console:
# EC2 → Security Groups → Find your backend's security group → Copy Group ID
```

## Testing After Launch

Once instance is running:

```bash
# Test from your backend
curl http://your-ec2-ip:3001/health

# Should return:
# {"status":"healthy","activeMeetings":0,"timestamp":"..."}
```

