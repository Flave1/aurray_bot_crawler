#!/bin/bash
# Script to diagnose ECR permission issues
# Usage: ./scripts/diagnose_ecr_issue.sh [username]

set -e

USER_NAME="${1:-dynomo_admin}"

echo "🔍 Diagnosing ECR Permission Issues for: $USER_NAME"
echo ""

# Check attached policies
echo "📋 Step 1: Checking attached policies..."
echo "Attached Managed Policies:"
aws iam list-attached-user-policies --user-name "$USER_NAME" --region us-east-1 --output table

echo ""
echo "📋 Step 2: Checking inline policies..."
INLINE_POLICIES=$(aws iam list-user-policies --user-name "$USER_NAME" --region us-east-1 --query 'PolicyNames' --output text)
if [ -n "$INLINE_POLICIES" ] && [ "$INLINE_POLICIES" != "None" ]; then
    echo "Found inline policies: $INLINE_POLICIES"
    for policy in $INLINE_POLICIES; do
        echo ""
        echo "Policy: $policy"
        aws iam get-user-policy --user-name "$USER_NAME" --policy-name "$policy" --region us-east-1 --query 'PolicyDocument' --output json | python3 -m json.tool
    done
else
    echo "No inline policies found"
fi

echo ""
echo "📋 Step 3: Checking groups..."
GROUPS=$(aws iam list-groups-for-user --user-name "$USER_NAME" --region us-east-1 --query 'Groups[*].GroupName' --output text)
if [ -n "$GROUPS" ] && [ "$GROUPS" != "None" ]; then
    echo "User belongs to groups: $GROUPS"
    for group in $GROUPS; do
        echo ""
        echo "Group: $group"
        echo "Attached policies:"
        aws iam list-attached-group-policies --group-name "$group" --region us-east-1 --output table
        echo "Inline policies:"
        GROUP_INLINE=$(aws iam list-group-policies --group-name "$group" --region us-east-1 --query 'PolicyNames' --output text)
        if [ -n "$GROUP_INLINE" ] && [ "$GROUP_INLINE" != "None" ]; then
            for policy in $GROUP_INLINE; do
                echo "  - $policy"
                aws iam get-group-policy --group-name "$group" --policy-name "$policy" --region us-east-1 --query 'PolicyDocument' --output json | python3 -m json.tool
            done
        fi
    done
else
    echo "User is not a member of any groups"
fi

echo ""
echo "📋 Step 4: Testing ECR access..."
if aws ecr get-authorization-token --region us-east-1 &>/dev/null; then
    echo "✅ ECR access is working!"
else
    echo "❌ ECR access is blocked"
    echo ""
    echo "🔍 Looking for explicit deny statements..."
    echo "Check the policies above for 'Effect: Deny' statements that mention 'ecr:*' or 'ecr:GetAuthorizationToken'"
fi

echo ""
echo "💡 Next Steps:"
echo "1. Look for policies with 'Effect: Deny' and 'Action: ecr:*' or 'ecr:GetAuthorizationToken'"
echo "2. Remove or modify those deny statements"
echo "3. Or use a different IAM user/role for ECR operations"

