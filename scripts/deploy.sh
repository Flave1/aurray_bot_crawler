#!/bin/bash
# Script to build and deploy the browser bot to AWS ECS
# Usage: ./scripts/deploy.sh [cluster-name] [service-name] [image-tag]

set -euo pipefail

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="588412562130"
ECR_REPOSITORY="browser_bot"
IMAGE_TAG="${3:-browser-bot-$(date +%Y%m%d%H%M%S)}"
CLUSTER_NAME="${1:-clerk-cluster}"
SERVICE_NAME="${2:-browser-bot-service}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE_PATH="$ROOT_DIR/Dockerfile"
TASK_DEF_JSON="$ROOT_DIR/ecs-task-def.json"

if [[ ! -f "$TASK_DEF_JSON" ]]; then
  echo "❌ Task definition template not found at $TASK_DEF_JSON"
  echo "Please create ecs-task-def.json with the base task definition before deploying."
  exit 1
fi

ECR_IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}"

step() {
  echo ""
  echo "🔹 $1"
}

step "Logging into ECR..."
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

step "Building Docker image ($IMAGE_TAG)..."
docker build -f "$DOCKERFILE_PATH" -t "${ECR_REPOSITORY}:${IMAGE_TAG}" "$ROOT_DIR"

step "Tagging image for ECR..."
docker tag "${ECR_REPOSITORY}:${IMAGE_TAG}" "$ECR_IMAGE_URI"

step "Pushing image to ECR..."
docker push "$ECR_IMAGE_URI"

step "Preparing task definition with new image..."
TEMP_TASK_DEF="/tmp/browser-bot-task-${IMAGE_TAG}.json"
python3 <<EOF > "$TEMP_TASK_DEF"
import json
from pathlib import Path

task_def_path = Path("$TASK_DEF_JSON")
with task_def_path.open() as f:
    task_def = json.load(f)

if not task_def.get("containerDefinitions"):
    raise SystemExit("Task definition template must contain at least one container definition")

task_def["containerDefinitions"][0]["image"] = "$ECR_IMAGE_URI"

print(json.dumps(task_def, indent=2))
EOF

step "Registering new task definition..."
TASK_DEF_ARN=$(aws ecs register-task-definition \
  --region "$AWS_REGION" \
  --cli-input-json "file://$TEMP_TASK_DEF" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)
rm -f "$TEMP_TASK_DEF"
echo "✅ Task definition: $TASK_DEF_ARN"

step "Updating ECS service..."
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER_NAME" \
  --service "$SERVICE_NAME" \
  --task-definition "$TASK_DEF_ARN" \
  --force-new-deployment > /dev/null

echo "✅ Service update initiated for $SERVICE_NAME on $CLUSTER_NAME"

echo ""
echo "Next steps:"
echo "  • Monitor deployment: aws ecs wait services-stable --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $AWS_REGION"
echo "  • Verify logs and health checks once the service is stable."
