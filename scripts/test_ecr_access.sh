#!/bin/bash
# Script to test ECR access and permissions
# Usage: ./scripts/test_ecr_access.sh

set -e

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="588412562130"
ECR_REPOSITORY="bot_staging"

echo "🧪 Testing ECR Access"
echo "Region: $AWS_REGION"
echo "Account: $AWS_ACCOUNT_ID"
echo "Repository: $ECR_REPOSITORY"
echo ""

# Test 1: Get Authorization Token
echo "📝 Test 1: Getting ECR authorization token..."
if aws ecr get-authorization-token --region $AWS_REGION &>/dev/null; then
    echo "✅ ecr:GetAuthorizationToken - SUCCESS"
else
    echo "❌ ecr:GetAuthorizationToken - FAILED"
    exit 1
fi

# Test 2: Check if repository exists
echo ""
echo "📝 Test 2: Checking if repository exists..."
if aws ecr describe-repositories --repository-names $ECR_REPOSITORY --region $AWS_REGION &>/dev/null; then
    echo "✅ Repository exists"
    REPO_EXISTS=true
else
    echo "⚠️  Repository does not exist (will test creation)"
    REPO_EXISTS=false
fi

# Test 3: Create repository (if it doesn't exist)
if [ "$REPO_EXISTS" = false ]; then
    echo ""
    echo "📝 Test 3: Creating repository..."
    if aws ecr create-repository \
        --repository-name $ECR_REPOSITORY \
        --region $AWS_REGION \
        --image-scanning-configuration scanOnPush=true \
        --encryption-configuration encryptionType=AES256 &>/dev/null; then
        echo "✅ ecr:CreateRepository - SUCCESS"
    else
        echo "❌ ecr:CreateRepository - FAILED"
        exit 1
    fi
else
    echo ""
    echo "📝 Test 3: Repository already exists, skipping creation"
fi

# Test 4: Describe repository
echo ""
echo "📝 Test 4: Describing repository..."
if aws ecr describe-repositories --repository-names $ECR_REPOSITORY --region $AWS_REGION &>/dev/null; then
    echo "✅ ecr:DescribeRepositories - SUCCESS"
    REPO_URI=$(aws ecr describe-repositories \
        --repository-names $ECR_REPOSITORY \
        --region $AWS_REGION \
        --query 'repositories[0].repositoryUri' \
        --output text)
    echo "   Repository URI: $REPO_URI"
else
    echo "❌ ecr:DescribeRepositories - FAILED"
    exit 1
fi

# Test 5: List images (may be empty)
echo ""
echo "📝 Test 5: Listing images in repository..."
if aws ecr list-images --repository-name $ECR_REPOSITORY --region $AWS_REGION &>/dev/null; then
    echo "✅ ecr:ListImages - SUCCESS"
    IMAGE_COUNT=$(aws ecr list-images --repository-name $ECR_REPOSITORY --region $AWS_REGION --query 'length(imageIds)' --output text)
    echo "   Images in repository: $IMAGE_COUNT"
else
    echo "❌ ecr:ListImages - FAILED"
    exit 1
fi

# Test 6: Test Docker login
echo ""
echo "📝 Test 6: Testing Docker login to ECR..."
if aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com &>/dev/null; then
    echo "✅ Docker login - SUCCESS"
else
    echo "❌ Docker login - FAILED"
    exit 1
fi

# Test 7: Test layer operations (if image exists)
if [ "$IMAGE_COUNT" -gt 0 ]; then
    echo ""
    echo "📝 Test 7: Testing layer operations..."
    
    # Get the latest image
    LATEST_IMAGE=$(aws ecr list-images \
        --repository-name $ECR_REPOSITORY \
        --region $AWS_REGION \
        --query 'imageIds[0].imageTag' \
        --output text)
    
    if [ "$LATEST_IMAGE" != "None" ] && [ -n "$LATEST_IMAGE" ]; then
        echo "   Testing with image tag: $LATEST_IMAGE"
        
        # Test BatchCheckLayerAvailability
        if aws ecr batch-check-layer-availability \
            --repository-name $ECR_REPOSITORY \
            --layer-digests "sha256:test" \
            --region $AWS_REGION &>/dev/null; then
            echo "✅ ecr:BatchCheckLayerAvailability - SUCCESS"
        else
            echo "⚠️  ecr:BatchCheckLayerAvailability - Test inconclusive (expected with test digest)"
        fi
        
        # Test BatchGetImage
        if aws ecr batch-get-image \
            --repository-name $ECR_REPOSITORY \
            --image-ids imageTag=$LATEST_IMAGE \
            --region $AWS_REGION &>/dev/null; then
            echo "✅ ecr:BatchGetImage - SUCCESS"
        else
            echo "⚠️  ecr:BatchGetImage - Test inconclusive"
        fi
    fi
else
    echo ""
    echo "📝 Test 7: Skipping layer operations (no images in repository)"
    echo "   Push an image first to test layer operations"
fi

echo ""
echo "✅ All ECR access tests completed!"
echo ""
echo "📋 Summary:"
echo "   ✅ Authorization token: Working"
echo "   ✅ Repository access: Working"
echo "   ✅ Docker login: Working"
if [ "$REPO_EXISTS" = false ]; then
    echo "   ✅ Repository created: $ECR_REPOSITORY"
fi
echo ""
echo "🚀 You can now push images using:"
echo "   ./scripts/deploy_to_ecs.sh"

