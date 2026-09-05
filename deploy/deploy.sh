#!/usr/bin/env bash
# One-command deploy of the whole backend into your own AWS account.
#
# Packages both Lambdas, uploads them to a code bucket it creates on first run,
# and creates or updates the CloudFormation stack. Safe to re-run: it is the
# same command for the first deploy and every one after it.
#
# The two functions import only the AWS SDK, which the Node 20 runtime already
# provides, so there is no npm install and no bundler anywhere in here.
#
# Usage:
#   deploy/deploy.sh \
#     --password 'something-long-and-unguessable' \
#     --from birthdays@yourdomain.com \
#     --to you@example.com \
#     --origin https://yourname.github.io
#
# Everything else has a sensible default. --help lists the rest.

set -euo pipefail

STACK="bdayapp"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
PASSWORD=""
FROM=""
TO=""
ORIGIN=""
APP_URL=""
TZ_NAME="America/Chicago"
HOUR="8"
RETENTION="30"
BUCKET=""

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --password   Sign-in password for the app. Required on first deploy.
  --from       Verified SES sender address. Required.
  --to         Comma-separated recipients of the reminder. Required.
  --origin     Exact origin the front end is served from. Required.
               e.g. https://yourname.github.io
  --app-url    Link shown at the bottom of the email. Optional.
  --stack      Stack name (default: bdayapp).
  --region     AWS region (default: $AWS_REGION, else us-east-1).
  --timezone   IANA zone the day boundary is counted in (default: America/Chicago).
  --hour       Hour of day 0-23 to send (default: 8).
  --retention  Days to keep Lambda logs (default: 30).
  --bucket     Code bucket to reuse. Default is derived from account and stack.
  -h, --help   This text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)  PASSWORD="$2"; shift 2;;
    --from)      FROM="$2"; shift 2;;
    --to)        TO="$2"; shift 2;;
    --origin)    ORIGIN="$2"; shift 2;;
    --app-url)   APP_URL="$2"; shift 2;;
    --stack)     STACK="$2"; shift 2;;
    --region)    REGION="$2"; shift 2;;
    --timezone)  TZ_NAME="$2"; shift 2;;
    --hour)      HOUR="$2"; shift 2;;
    --retention) RETENTION="$2"; shift 2;;
    --bucket)    BUCKET="$2"; shift 2;;
    -h|--help)   usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

case "$ORIGIN" in
  ""|https://*|http://*) ;;
  *) echo "ERROR: --origin must start with https:// or http:// (got '$ORIGIN')." >&2; exit 2;;
esac
case "$ORIGIN" in
  *"*"*) echo "ERROR: --origin must be one exact origin, not a wildcard." >&2; exit 2;;
esac

have aws || { echo "ERROR: the AWS CLI is required but not installed." >&2; exit 1; }

# Zipping is the one step with no single portable tool. Plenty of otherwise
# fine environments - a stock Windows shell, a slim container - have no zip(1),
# and failing there would be a silly reason not to be able to deploy.
if have zip; then                 ZIPPER="zip"
elif have python3; then           ZIPPER="python3"
elif have python;  then           ZIPPER="python"
elif have pwsh;    then           ZIPPER="pwsh"
elif have powershell; then        ZIPPER="powershell"
else
  echo "ERROR: need one of zip, python3, python or powershell to package the functions." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Whether the stack already exists decides which parameters we must be given.
# On an update, anything omitted keeps its current value rather than being
# silently reset -- which is what makes re-running this safe.
if aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  EXISTS=1
else
  EXISTS=0
fi

if [ "$EXISTS" -eq 0 ]; then
  missing=""
  [ -z "$PASSWORD" ] && missing="$missing --password"
  [ -z "$FROM" ]     && missing="$missing --from"
  [ -z "$TO" ]       && missing="$missing --to"
  [ -z "$ORIGIN" ]   && missing="$missing --origin"
  if [ -n "$missing" ]; then
    echo "ERROR: first deploy needs:$missing" >&2
    echo >&2
    usage >&2
    exit 2
  fi
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[ -z "$BUCKET" ] && BUCKET="${STACK}-code-${ACCOUNT}-${REGION}"

echo "==> Account $ACCOUNT, region $REGION, stack $STACK"

# ── 1. Code bucket ────────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Using existing code bucket $BUCKET"
else
  echo "==> Creating code bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  # Nothing in here is public, and a stale bundle should never be recoverable
  # as the "current" one by accident.
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
  aws s3api put-bucket-encryption --bucket "$BUCKET" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
  aws s3api put-bucket-versioning --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled >/dev/null
fi

# ── 2. Package ────────────────────────────────────────────────────────
# Keys are content-addressed. CloudFormation only updates a function when its
# S3Key changes, so a fixed key would leave stale code running after an edit.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-12
  else shasum -a 256 "$1" | cut -c1-12; fi
}

# A Lambda bundle is one file named index.mjs at the root of a zip. Whichever
# tool is available, the archive it produces is the same.
package() {  # <source .mjs> <name>
  local src="$1" name="$2"
  cp "$src" "$WORK/index.mjs"
  case "$ZIPPER" in
    zip)
      ( cd "$WORK" && zip -q "$name.zip" index.mjs ) ;;
    python3|python)
      ( cd "$WORK" && "$ZIPPER" -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.write('index.mjs'); z.close()" "$name.zip" ) ;;
    pwsh|powershell)
      ( cd "$WORK" && "$ZIPPER" -NoProfile -Command "Compress-Archive -Path index.mjs -DestinationPath '$name.zip' -Force" ) ;;
  esac
  rm "$WORK/index.mjs"
  hash_of "$WORK/$name.zip"
}

echo "==> Packaging functions"
API_HASH="$(package "$ROOT/backend/index.mjs" api)"
REM_HASH="$(package "$ROOT/backend/reminder.mjs" reminder)"
API_KEY="api-${API_HASH}.zip"
REM_KEY="reminder-${REM_HASH}.zip"

echo "==> Uploading bundles"
aws s3 cp "$WORK/api.zip"      "s3://$BUCKET/$API_KEY"  --region "$REGION" >/dev/null
aws s3 cp "$WORK/reminder.zip" "s3://$BUCKET/$REM_KEY"  --region "$REGION" >/dev/null

# ── 3. Deploy ─────────────────────────────────────────────────────────
# On an update, omitted values reuse what the stack already has.
params=(
  "CodeBucket=$BUCKET"
  "ApiCodeKey=$API_KEY"
  "ReminderCodeKey=$REM_KEY"
  "TimeZone=$TZ_NAME"
  "ReminderHour=$HOUR"
  "LogRetentionDays=$RETENTION"
)
[ -n "$PASSWORD" ] && params+=("HouseholdPassword=$PASSWORD")
[ -n "$FROM" ]     && params+=("FromAddress=$FROM")
[ -n "$TO" ]       && params+=("ToAddresses=$TO")
[ -n "$ORIGIN" ]   && params+=("AllowedOrigin=$ORIGIN")
[ -n "$APP_URL" ]  && params+=("AppUrl=$APP_URL")

echo "==> Deploying stack"
aws cloudformation deploy \
  --template-file "$HERE/template.yaml" \
  --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${params[@]}"

ENDPOINT="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)"

cat <<EOF

Done.

  API endpoint : $ENDPOINT
  Stack        : $STACK ($REGION)
  Code bucket  : s3://$BUCKET

Next: publish the front end with API_ENDPOINT set to the endpoint above.
On GitHub Pages that is a repository secret named API_ENDPOINT; the included
workflow reads it. Set HOUSEHOLD_PASSWORD too if you want the no-login flow -
read the note in the root README first, it lands in the published HTML.

Check the reminder end to end with:

  aws lambda invoke --function-name $STACK-reminder \\
    --region $REGION --payload '{}' /tmp/out.json && cat /tmp/out.json

With nothing due you should see {"sent":0,...,"reason":"nothing due"}.
EOF
