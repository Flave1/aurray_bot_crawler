#!/bin/bash
# Script to set up ECR permissions for IAM user or role
# Usage: ./scripts/setup_ecr_permissions.sh [user-name|role-name] [user|role]

set -e

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="588412562130"
ECR_REPOSITORY="bot_staging"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <user-name-or-role-name> [user|role]"
    echo "Example: $0 dynomo_admin user"
    echo "Example: $0 ecsTaskExecutionRole role"
    exit 1
fi

ENTITY_NAME="$1"
ENTITY_TYPE="${2:-user}"

echo "🔐 Setting up ECR permissions for $ENTITY_TYPE: $ENTITY_NAME"
echo "Region: $AWS_REGION"
echo "Account: $AWS_ACCOUNT_ID"
echo "Repository: $ECR_REPOSITORY"
echo ""

# Create IAM policy document for ECR access
POLICY_NAME="ECRFullAccess-${ECR_REPOSITORY}"
POLICY_FILE="/tmp/ecr-policy-${ECR_REPOSITORY}.json"

cat > "$POLICY_FILE" << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRGetAuthorizationToken",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECRRepositoryAccess",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:TagResource",
        "ecr:UntagResource",
        "ecr:GetRepositoryPolicy",
        "ecr:SetRepositoryPolicy",
        "ecr:DeleteRepository",
        "ecr:BatchDeleteImage"
      ],
      "Resource": [
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/${ECR_REPOSITORY}",
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/*"
      ]
    }
  ]
}
EOF

echo "📋 Created policy document: $POLICY_FILE"
echo ""

# Check if policy already exists
if aws iam get-policy --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/${POLICY_NAME}" &>/dev/null; then
    echo "⚠️  Policy $POLICY_NAME already exists"
    read -p "Do you want to create a new version? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🔄 Creating new policy version..."
        aws iam create-policy-version \
            --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/${POLICY_NAME}" \
            --policy-document "file://${POLICY_FILE}" \
            --set-as-default \
            --region $AWS_REGION
        echo "✅ Policy version created"
    else
        echo "Using existing policy"
        POLICY_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:policy/${POLICY_NAME}"
    fi
else
    echo "📝 Creating new IAM policy: $POLICY_NAME"
    POLICY_ARN=$(aws iam create-policy \
        --policy-name "$POLICY_NAME" \
        --policy-document "file://${POLICY_FILE}" \
        --description "Full ECR access for ${ECR_REPOSITORY} repository" \
        --region $AWS_REGION \
        --query 'Policy.Arn' \
        --output text)
    echo "✅ Policy created: $POLICY_ARN"
fi

echo ""

# Attach policy to user or role
if [ "$ENTITY_TYPE" = "role" ]; then
    echo "🔗 Attaching policy to IAM role: $ENTITY_NAME"
    
    # Check if policy is already attached
    if aws iam list-attached-role-policies --role-name "$ENTITY_NAME" --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}']" --output text | grep -q "$POLICY_ARN"; then
        echo "✅ Policy already attached to role"
    else
        aws iam attach-role-policy \
            --role-name "$ENTITY_NAME" \
            --policy-arn "$POLICY_ARN" \
            --region $AWS_REGION
        echo "✅ Policy attached to role"
    fi
else
    echo "🔗 Attaching policy to IAM user: $ENTITY_NAME"
    
    # Check if policy is already attached
    if aws iam list-attached-user-policies --user-name "$ENTITY_NAME" --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}']" --output text | grep -q "$POLICY_ARN"; then
        echo "✅ Policy already attached to user"
    else
        aws iam attach-user-policy \
            --user-name "$ENTITY_NAME" \
            --policy-arn "$POLICY_ARN" \
            --region $AWS_REGION
        echo "✅ Policy attached to user"
    fi
fi

# Clean up
rm -f "$POLICY_FILE"

echo ""
echo "✅ ECR permissions setup completed!"
echo ""
echo "📋 Summary:"
echo "   Policy ARN: $POLICY_ARN"
echo "   Attached to: $ENTITY_TYPE/$ENTITY_NAME"
echo ""
echo "🧪 Test the permissions by running:"
echo "   ./scripts/test_ecr_access.sh"

