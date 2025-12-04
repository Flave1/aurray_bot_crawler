#!/bin/bash
# Script to clean up old browser-bot ECS tasks after deployment
# Usage: ./scripts/cleanup-old-tasks.sh [cluster-name] [service-name]

set -e

AWS_REGION="us-east-1"
CLUSTER_NAME="${1:-clerk-cluster}"
SERVICE_NAME="${2:-browser-bot-service}"

echo "🧹 Starting cleanup of old browser-bot tasks..."
echo "Cluster: $CLUSTER_NAME"
echo "Service: $SERVICE_NAME"
echo ""

# Step 1: Get the current task definition used by the service
echo "📋 Step 1: Getting current task definition from service..."
CURRENT_TASK_DEF=$(aws ecs describe-services \
    --cluster $CLUSTER_NAME \
    --services $SERVICE_NAME \
    --region $AWS_REGION \
    --query 'services[0].taskDefinition' \
    --output text)

if [ -z "$CURRENT_TASK_DEF" ] || [ "$CURRENT_TASK_DEF" == "None" ]; then
    echo "⚠️  Service not found or no task definition. Nothing to clean up."
    exit 0
fi

echo "✅ Current task definition: $CURRENT_TASK_DEF"

# Extract task family and revision
TASK_FAMILY=$(echo $CURRENT_TASK_DEF | sed 's/.*task-definition\/\(.*\):[0-9]*/\1/')
CURRENT_REVISION=$(echo $CURRENT_TASK_DEF | sed 's/.*:\([0-9]*\)$/\1/')

echo "   Family: $TASK_FAMILY"
echo "   Revision: $CURRENT_REVISION"
echo ""

# Step 2: List all running tasks in the cluster
echo "📝 Step 2: Listing all running tasks..."
RUNNING_TASKS=$(aws ecs list-tasks \
    --cluster $CLUSTER_NAME \
    --region $AWS_REGION \
    --desired-status RUNNING \
    --query 'taskArns[]' \
    --output text)

if [ -z "$RUNNING_TASKS" ]; then
    echo "✅ No tasks found. Nothing to clean up."
    exit 0
fi

echo "✅ Found running tasks"
echo ""

# Step 3: Check each task and stop if using old task definition
echo "🔍 Step 3: Checking tasks for old versions..."
TASKS_STOPPED=0

for TASK_ARN in $RUNNING_TASKS; do
    # Get task details
    TASK_INFO=$(aws ecs describe-tasks \
        --cluster $CLUSTER_NAME \
        --tasks $TASK_ARN \
        --region $AWS_REGION \
        --query 'tasks[0].{TaskDef:taskDefinitionArn,Container:containers[0].name}' \
        --output json)
    
    TASK_DEF=$(echo $TASK_INFO | jq -r '.TaskDef')
    CONTAINER_NAME=$(echo $TASK_INFO | jq -r '.Container')
    
    # Skip if task info is invalid
    if [ "$TASK_DEF" == "null" ] || [ -z "$TASK_DEF" ]; then
        continue
    fi
    
    # Extract family and revision from this task
    THIS_FAMILY=$(echo $TASK_DEF | sed 's/.*task-definition\/\(.*\):[0-9]*/\1/')
    THIS_REVISION=$(echo $TASK_DEF | sed 's/.*:\([0-9]*\)$/\1/')
    
    # Only process browser-bot tasks - skip clerk_backend tasks
    if [[ "$THIS_FAMILY" != *"browser-bot"* ]] && [[ "$CONTAINER_NAME" != *"browser"* ]]; then
        echo "⏭️  Skipping non-browser-bot task: $(basename $TASK_ARN) (family: $THIS_FAMILY)"
        continue
    fi
    
    # Skip if this is not the same family as our service
    if [ "$THIS_FAMILY" != "$TASK_FAMILY" ]; then
        echo "⏭️  Skipping different browser-bot family: $THIS_FAMILY ($(basename $TASK_ARN))"
        continue
    fi
    
    # Check if this task is using an old revision
    if [ "$THIS_REVISION" != "$CURRENT_REVISION" ]; then
        echo "🗑️  Stopping old browser-bot task: $(basename $TASK_ARN) (using revision $THIS_REVISION)"
        aws ecs stop-task \
            --cluster $CLUSTER_NAME \
            --task $TASK_ARN \
            --region $AWS_REGION \
            --reason "Cleaning up old browser-bot task definition after deployment" \
            --output json > /dev/null
        TASKS_STOPPED=$((TASKS_STOPPED + 1))
        echo "   ✅ Task stopped"
    else
        echo "✅ Task is current: $(basename $TASK_ARN) (revision $THIS_REVISION)"
    fi
done

echo ""
echo "✨ Cleanup complete!"
echo "   Tasks stopped: $TASKS_STOPPED"
echo ""

# Step 4: Show final state
echo "📊 Final cluster state:"
aws ecs list-tasks \
    --cluster $CLUSTER_NAME \
    --region $AWS_REGION \
    --desired-status RUNNING \
    --query 'taskArns[]' \
    --output text | wc -l | xargs echo "   Running tasks:"

echo ""
echo "✅ Cleanup completed successfully!"

