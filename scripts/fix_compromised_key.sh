#!/bin/bash
# Script to fix compromised key issue
# The AWSCompromisedKeyQuarantineV3 policy is blocking ECR access

set -e

USER_NAME="${1:-dynomo_admin}"

echo "🔐 Fixing Compromised Key Issue for: $USER_NAME"
echo ""
echo "⚠️  ISSUE FOUND: AWSCompromisedKeyQuarantineV3 policy is blocking ECR access"
echo "This policy is applied when AWS detects a compromised access key."
echo ""

echo "📋 Current access keys for $USER_NAME:"
aws iam list-access-keys --user-name "$USER_NAME" --region us-east-1 --output table

echo ""
echo "🔧 SOLUTION OPTIONS:"
echo ""
echo "Option 1: Remove the quarantine policy (if key is safe)"
echo "  aws iam detach-user-policy \\"
echo "    --user-name $USER_NAME \\"
echo "    --policy-arn arn:aws:iam::aws:policy/AWSCompromisedKeyQuarantineV3"
echo ""
echo "Option 2: Create new access keys and delete old ones (RECOMMENDED)"
echo "  # List current keys"
echo "  aws iam list-access-keys --user-name $USER_NAME"
echo ""
echo "  # Create new key"
echo "  aws iam create-access-key --user-name $USER_NAME"
echo ""
echo "  # Delete old compromised key"
echo "  aws iam delete-access-key --user-name $USER_NAME --access-key-id <OLD_KEY_ID>"
echo ""
echo "Option 3: Use a different IAM user for ECR operations"
echo ""

read -p "Do you want to proceed with Option 2 (create new keys)? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "📝 Creating new access key..."
    NEW_KEY=$(aws iam create-access-key --user-name "$USER_NAME" --region us-east-1 --output json)
    
    ACCESS_KEY_ID=$(echo "$NEW_KEY" | python3 -c "import sys, json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
    SECRET_ACCESS_KEY=$(echo "$NEW_KEY" | python3 -c "import sys, json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")
    
    echo "✅ New access key created!"
    echo ""
    echo "🔑 NEW CREDENTIALS (SAVE THESE SECURELY):"
    echo "   AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID"
    echo "   AWS_SECRET_ACCESS_KEY=$SECRET_ACCESS_KEY"
    echo ""
    echo "⚠️  IMPORTANT:"
    echo "   1. Save these credentials securely"
    echo "   2. Update your AWS credentials file (~/.aws/credentials)"
    echo "   3. Delete the old compromised key"
    echo "   4. The quarantine policy should be removed automatically after using new keys"
    echo ""
    echo "To update credentials, run:"
    echo "  aws configure set aws_access_key_id $ACCESS_KEY_ID"
    echo "  aws configure set aws_secret_access_key $SECRET_ACCESS_KEY"
    echo ""
    echo "To delete old keys, run:"
    echo "  aws iam list-access-keys --user-name $USER_NAME"
    echo "  aws iam delete-access-key --user-name $USER_NAME --access-key-id <OLD_KEY_ID>"
else
    echo ""
    echo "Skipped. Please choose one of the options above."
fi

