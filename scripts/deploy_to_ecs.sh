#!/bin/bash
# Script to build, push, and register browser bot Docker image to ECS
# Usage: ./scripts/deploy_to_ecs.sh

set -e

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="588412562130"
ECR_REPOSITORY="bot_staging"
IMAGE_TAG="v1.0.0"
CLUSTER_NAME="${CLUSTER_NAME:-clerk-cluster}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "🚀 Deploying browser bot to ECS"
echo "Region: $AWS_REGION"
echo "Repository: $ECR_REPOSITORY"
echo "Image Tag: $IMAGE_TAG"
echo ""

# Step 1: Login to ECR
echo "📝 Step 1: Logging into ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Step 2: Check if ECR repository exists, create if not
echo ""
echo "🔍 Step 2: Checking ECR repository..."
if ! aws ecr describe-repositories --repository-names $ECR_REPOSITORY --region $AWS_REGION &>/dev/null; then
    echo "Creating ECR repository: $ECR_REPOSITORY"
    aws ecr create-repository \
        --repository-name $ECR_REPOSITORY \
        --region $AWS_REGION \
        --image-scanning-configuration scanOnPush=true \
        --encryption-configuration encryptionType=AES256
    echo "✅ Repository created"
else
    echo "✅ Repository exists"
fi

# Step 3: Build Docker image (if not already built)
echo ""
echo "🔨 Step 3: Building Docker image..."
if ! docker images | grep -q "bot_staging.*$IMAGE_TAG"; then
    docker build -t bot_staging:$IMAGE_TAG .
    echo "✅ Image built"
else
    echo "✅ Image already exists locally"
fi

# Step 4: Tag image for ECR
echo ""
echo "🏷️  Step 4: Tagging image for ECR..."
ECR_IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}"
docker tag bot_staging:$IMAGE_TAG $ECR_IMAGE_URI

# Step 5: Push to ECR
echo ""
echo "📤 Step 5: Pushing image to ECR..."
docker push $ECR_IMAGE_URI
echo "✅ Image pushed to ECR"

# Step 6: Update task definition with image URI
echo ""
echo "📋 Step 6: Updating task definition..."
TASK_DEF_JSON="ecs-task-def.json"
TEMP_TASK_DEF="/tmp/bot-task-${IMAGE_TAG}.json"
python3 << EOF > ${TEMP_TASK_DEF}
import json

with open('${TASK_DEF_JSON}', 'r') as f:
    task_def = json.load(f)

# Update the image URI in the container definition
task_def['containerDefinitions'][0]['image'] = '${ECR_IMAGE_URI}'

print(json.dumps(task_def, indent=2))
EOF

# Step 7: Register task definition
echo ""
echo "📝 Step 7: Registering task definition..."
TASK_DEF_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://${TEMP_TASK_DEF} \
    --region $AWS_REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)
rm -f ${TEMP_TASK_DEF}

echo "✅ Task definition registered: $TASK_DEF_ARN"
echo ""
echo "📊 Task Definition Details:"
aws ecs describe-task-definition \
    --task-definition $TASK_DEF_ARN \
    --region $AWS_REGION \
    --query 'taskDefinition.{Family:family,Revision:revision,Status:status,CPU:cpu,Memory:memory}' \
    --output table

echo ""
echo "✅ Deployment completed successfully!"
echo ""
echo "Next steps:"
echo "1. Configure backend settings:"
echo "   - Set BOT_DEPLOYMENT_METHOD=ecs (or auto)"
echo "   - Set ECS_TASK_DEFINITION=clerk-browser-bot"
echo "   - Set ECS_CLUSTER_NAME=$CLUSTER_NAME"
echo "   - Set ECS_SUBNET_IDS (comma-separated subnet IDs)"
echo "   - Set ECS_SECURITY_GROUP_IDS (comma-separated security group IDs)"
echo ""
echo "2. The backend will use ECS RunTask to launch bot containers on-demand"
echo "3. Each meeting will spawn a new Fargate task with the bot image"

