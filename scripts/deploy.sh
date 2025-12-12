#!/bin/bash
# Script to build and deploy Browser Bot to AWS ECS
# Usage: ./scripts/deploy.sh [cluster-name] [image-tag]
# Environment: Set ENVIRONMENT=production for production, defaults to staging
# Note: Browser bots are launched on-demand, so this only registers the task definition

set -euo pipefail

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="588412562130"
ENVIRONMENT="${ENVIRONMENT:-staging}"

# Use single repository with environment-based tags
ECR_REPOSITORY="aurray_bot"
if [ "$ENVIRONMENT" = "production" ]; then
    IMAGE_TAG="${2:-production-latest}"
    CLUSTER_NAME="${1:-aurray-cluster}"
    TASK_DEF_JSON="aurray_bot_production.json"
    CONTAINER_NAME="bot_production"
else
    IMAGE_TAG="${2:-staging-latest}"
    CLUSTER_NAME="${1:-aurray-cluster}"
    TASK_DEF_JSON="aurray_bot_staging.json"
    CONTAINER_NAME="bot_staging"
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE_PATH="$ROOT_DIR/Dockerfile"
TASK_DEF_PATH="$ROOT_DIR/${TASK_DEF_JSON}"

if [[ ! -f "$TASK_DEF_PATH" ]]; then
  echo "❌ Task definition not found at $TASK_DEF_PATH"
  echo "Please create the task definition file before deploying."
  exit 1
fi

ECR_IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}"

step() {
  echo ""
  echo "🔹 $1"
}

echo "🚀 Starting browser bot deployment..."
echo "Environment: $ENVIRONMENT"
echo "Repository: $ECR_REPOSITORY"
echo "Image Tag: $IMAGE_TAG"
echo "Cluster: $CLUSTER_NAME"
echo ""

step "Logging into ECR..."
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

step "Building Docker image ($IMAGE_TAG)..."
docker build -f "$DOCKERFILE_PATH" -t "${ECR_REPOSITORY}:${IMAGE_TAG}" "$ROOT_DIR"

step "Tagging image for ECR..."
docker tag "${ECR_REPOSITORY}:${IMAGE_TAG}" "$ECR_IMAGE_URI"

step "Pushing image to ECR..."
docker push "$ECR_IMAGE_URI"

step "Preparing task definition with new image..."
TEMP_TASK_DEF="/tmp/aurray-bot-task-${IMAGE_TAG}.json"
python3 <<EOF > "$TEMP_TASK_DEF"
import json
from pathlib import Path

task_def_path = Path("$TASK_DEF_PATH")
with task_def_path.open() as f:
    task_def = json.load(f)

if not task_def.get("containerDefinitions"):
    raise SystemExit("Task definition must contain at least one container definition")

# Update image URI for the container
for container in task_def["containerDefinitions"]:
    if container["name"] == "$CONTAINER_NAME":
        container["image"] = "$ECR_IMAGE_URI"
        break

print(json.dumps(task_def, indent=2))
EOF

step "Registering new task definition..."
TASK_DEF_ARN=$(aws ecs register-task-definition \
  --region "$AWS_REGION" \
  --cli-input-json "file://$TEMP_TASK_DEF" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)
rm -f "$TEMP_TASK_DEF"

echo "✅ Task definition registered: $TASK_DEF_ARN"
echo ""
echo "✅ Deployment completed successfully!"
echo ""
echo "ℹ️  Note: Browser bots are launched on-demand by the backend orchestrator."
echo "   The task definition is now ready to use for launching bot tasks."
