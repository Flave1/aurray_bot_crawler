#!/bin/bash
# Script to grant ECR permissions to an ECS task execution role
# This is useful for allowing ECS tasks to pull images from ECR
# Usage: ./scripts/grant_ecr_permissions_to_role.sh [role-name]

set -e

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="588412562130"
ROLE_NAME="${1:-ecsTaskExecutionRole}"

echo "🔐 Granting ECR permissions to IAM role: $ROLE_NAME"
echo "Region: $AWS_REGION"
echo "Account: $AWS_ACCOUNT_ID"
echo ""

# Check if role exists
if ! aws iam get-role --role-name "$ROLE_NAME" &>/dev/null; then
    echo "❌ Role $ROLE_NAME does not exist"
    exit 1
fi

echo "✅ Role exists: $ROLE_NAME"
echo ""

# Create policy for ECR pull access (for ECS tasks to pull images)
POLICY_NAME="ECRPullAccess-${ROLE_NAME}"
POLICY_FILE="/tmp/ecr-pull-policy.json"

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
      "Sid": "ECRPullAccess",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages"
      ],
      "Resource": [
        "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/*"
      ]
    }
  ]
}
EOF

echo "📋 Created pull policy document"
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
        --description "ECR pull access for ${ROLE_NAME} to pull Docker images" \
        --region $AWS_REGION \
        --query 'Policy.Arn' \
        --output text)
    echo "✅ Policy created: $POLICY_ARN"
fi

echo ""

# Attach policy to role
echo "🔗 Attaching policy to IAM role: $ROLE_NAME"

# Check if policy is already attached
if aws iam list-attached-role-policies --role-name "$ROLE_NAME" --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}']" --output text | grep -q "$POLICY_ARN"; then
    echo "✅ Policy already attached to role"
else
    aws iam attach-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-arn "$POLICY_ARN" \
        --region $AWS_REGION
    echo "✅ Policy attached to role"
fi

# Clean up
rm -f "$POLICY_FILE"

echo ""
echo "✅ ECR pull permissions granted to role: $ROLE_NAME"
echo ""
echo "📋 Summary:"
echo "   Policy ARN: $POLICY_ARN"
echo "   Role: $ROLE_NAME"
echo ""
echo "💡 This allows ECS tasks using this role to pull images from ECR"

