# The IAM policy files

Four JSON documents left over from setting this stack up by hand, before
`deploy/template.yaml` existed. **You probably do not need them.** The
CloudFormation template creates the same roles and policies and derives the
account ID and region itself, so the normal path is:

```bash
deploy/deploy.sh --password '...' --from you@yourdomain.com \
  --to you@example.com --origin https://yourname.github.io
```

They are kept because they are the readable version of what the template
creates, and because attaching a policy by hand is sometimes the fastest way to
debug an `AccessDenied`.

## Placeholders

These files ship with tokens rather than real values, so that nothing in this
repo names a specific AWS account:

| Token | Replace with | Find it |
|---|---|---|
| `ACCOUNT_ID` | Your 12-digit account ID | `aws sts get-caller-identity --query Account --output text` |
| `REGION` | The region you deployed to | `aws configure get region` |
| `FROM_ADDRESS` | Your verified SES sender | The address you passed as `--from` |

Resource names assume a stack named `bdayapp`. If you deployed under a
different `--stack` name, change `bdayapp-friends`, `bdayapp-reminder` and
`/bdayapp/*` to match.

## Filling them in

Substitute at apply time rather than editing the files, so the account ID never
gets committed:

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION="$(aws configure get region)"
FROM_ADDRESS="birthdays@yourdomain.com"

render() {
  sed -e "s/ACCOUNT_ID/$ACCOUNT_ID/g" \
      -e "s/REGION/$REGION/g" \
      -e "s|FROM_ADDRESS|$FROM_ADDRESS|g" "$1"
}

render backend/lambda-policy.json > /tmp/lambda-policy.json
```

Then attach it:

```bash
aws iam put-role-policy \
  --role-name bdayapp-app-role \
  --policy-name AppAccess \
  --policy-document file:///tmp/lambda-policy.json
```

Delete the rendered file afterwards; it names your account.

## What each one is

| File | Purpose |
|---|---|
| `trust-policy.json` | Lets Lambda assume the app role. No account-specific values. |
| `lambda-policy.json` | What the functions may do: the friends table only, this stack's SSM parameters only, KMS decrypt via SSM, and SES send restricted to one verified From address. |
| `scheduler-trust.json` | Lets EventBridge Scheduler assume the schedule role, restricted to your account so a scheduler in someone else's account cannot assume it. |
| `scheduler-policy.json` | Lets the schedule invoke the reminder function, and nothing else. |

The scoping is the point. Each grants one thing against one named resource
rather than a wildcard, which is what keeps a compromised function from
becoming a compromised account.
