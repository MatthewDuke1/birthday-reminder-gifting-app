#!/usr/bin/env bash
# deploy-aws.sh — Build and deploy to S3 + optional CloudFront invalidation
set -euo pipefail

[ ! -f .env ] && { echo "ERROR: .env not found. Copy .env.example and fill in your values."; exit 1; }
source .env

for var in EMAILJS_PUBLIC_KEY EMAILJS_SERVICE_ID EMAILJS_TEMPLATE_ID S3_BUCKET; do
  [ -z "${!var:-}" ] && { echo "ERROR: $var is not set in .env"; exit 1; }
done

echo "Injecting secrets…"
cp index.html index.built.html
sed -i "s|%%EMAILJS_PUBLIC_KEY%%|$EMAILJS_PUBLIC_KEY|g"   index.built.html
sed -i "s|%%EMAILJS_SERVICE_ID%%|$EMAILJS_SERVICE_ID|g"   index.built.html
sed -i "s|%%EMAILJS_TEMPLATE_ID%%|$EMAILJS_TEMPLATE_ID|g" index.built.html

echo "Uploading to s3://$S3_BUCKET …"
aws s3 cp index.built.html "s3://$S3_BUCKET/index.html" \
  --content-type "text/html" --cache-control "no-cache"

[ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ] && \
  aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/*"

rm index.built.html
echo "Done!"
