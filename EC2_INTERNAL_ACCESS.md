# EC2 Internal Access Configuration for Fargate

## Overview
This guide explains how to configure your EC2 instance running the browser bot to accept connections from Fargate tasks only, without exposing it to the public internet.

## Current Configuration

- **EC2 Private IP**: `172.31.72.162`
- **Port**: `3001`
- **Fargate Security Group**: `sg-0c579c5fbad5ace63` (from ECS_SECURITY_GROUP_IDS)
- **BOT_SERVER_URL**: `http://172.31.72.162:3001` (updated in task definition)

## Step 1: Configure EC2 Security Group

You need to add an inbound rule to the EC2 instance's security group that allows traffic **only** from your Fargate task's security group.

### Option A: Via AWS Console

1. Go to **EC2 Console** → **Security Groups**
2. Find the security group attached to your EC2 instance (`ec2-3-236-20-123.compute-1.amazonaws.com`)
3. Click **Edit inbound rules**
4. Add a new rule:
   - **Type**: Custom TCP
   - **Port range**: `3001`
   - **Source**: Select "Security Group"
   - **Security Group**: `sg-0c579c5fbad5ace63` (your Fargate security group)
   - **Description**: "Allow Fargate tasks to access browser bot"
5. Click **Save rules**

### Option B: Via AWS CLI

```bash
# First, find your EC2 instance's security group ID
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=dns-name,Values=ec2-3-236-20-123.compute-1.amazonaws.com" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)

# Get the security group ID
EC2_SG_ID=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' \
  --output text)

# Add inbound rule allowing traffic from Fargate security group
aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG_ID \
  --protocol tcp \
  --port 3001 \
  --source-group sg-0c579c5fbad5ace63 \
  --description "Allow Fargate tasks to access browser bot"
```

## Step 2: Verify VPC Connectivity

Ensure both your Fargate tasks and EC2 instance are in the same VPC or have VPC peering configured.

From your task definition, the subnets are:
- `subnet-0d31721eea10943e1`
- `subnet-0a5eb200c9023edc4`

To check if your EC2 instance is in the same VPC:

```bash
# Get EC2 instance VPC ID
aws ec2 describe-instances \
  --filters "Name=dns-name,Values=ec2-3-236-20-123.compute-1.amazonaws.com" \
  --query 'Reservations[0].Instances[0].VpcId' \
  --output text

# Get VPC ID for Fargate subnets
aws ec2 describe-subnets \
  --subnet-ids subnet-0d31721eea10943e1 \
  --query 'Subnets[0].VpcId' \
  --output text
```

If the VPC IDs match, they're in the same VPC and can communicate privately.

## Step 3: Update and Deploy Task Definition

The task definition has already been updated with the private IP. Register and deploy:

```bash
# Register the updated task definition
aws ecs register-task-definition \
  --cli-input-json file://clerk_backend/aurray_backend_task_staging.json

# Update the ECS service to use the new task definition
aws ecs update-service \
  --cluster <your-cluster-name> \
  --service <your-service-name> \
  --task-definition aurray_backend_staging \
  --force-new-deployment
```

## Step 4: Test Internal Connection

After deploying, you can test from within a Fargate task:

```bash
# SSH into EC2 and test if Fargate can reach it
# (The service should work, but you can verify with curl from Fargate logs)
```

## Security Benefits

✅ **No public internet access** - EC2 port 3001 is not exposed to 0.0.0.0/0
✅ **Internal communication only** - Only resources with the Fargate security group can connect
✅ **Lower attack surface** - Reduces risk of unauthorized access
✅ **Cost efficient** - No need for NAT Gateway for this communication (private IPs are free)

## Troubleshooting

### Connection Refused
- Verify security group rules are applied
- Check that both resources are in the same VPC
- Verify the EC2 service is running: `sudo systemctl status browser-bot`

### Timeout
- Check route tables in the VPC
- Verify security group outbound rules on Fargate allow traffic to EC2
- Check network ACLs (should allow by default)

### DNS Resolution
- Using private IP (`172.31.72.162`) bypasses DNS, so this shouldn't be an issue
- If using hostname, ensure VPC DNS resolution is enabled

