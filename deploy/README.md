# Deploy your own

This folder is the whole backend as one CloudFormation template. It creates the
database, both functions, the API, the daily schedule, and the IAM roles in your
own AWS account. Nothing here phones home to mine.

## What it costs

**For a household-sized list: effectively nothing.** Every service is
pay-per-request or has a permanent free tier that this workload does not come
close to exhausting.

Concretely, one reminder run a day with a few dozen birthdays:

| Service | Monthly usage | Cost |
|---|---|---|
| Lambda | ~30 reminder runs + a few hundred API calls | $0.00 — free tier is 1M requests |
| DynamoDB (on-demand) | a few thousand reads/writes, <1 MB stored | $0.00 — free tier is 25 GB + 200M requests |
| API Gateway (HTTP) | a few hundred calls | $0.00 — first 1M/month free for 12 months, then ~$1.00/M |
| EventBridge Scheduler | 30 invocations | $0.00 — first 14M/month free |
| SES | ~30 emails | $0.00 — $0.10 per 1,000 emails, so 30 rounds to nothing |
| SSM Parameter Store | 2 standard parameters | $0.00 |
| CloudWatch Logs | a few MB | $0.00 — 5 GB free |

**Realistic bill: $0.00–$0.50/month.** After the 12-month API Gateway free tier
expires, a busy month might reach a few cents.

Verified against the live stack this repo runs: Cost Explorer reports **$0.00**
for these services over the last 30 days.

Two things that would actually cost money, neither required:

- A custom domain with Route 53: **$0.50/month** per hosted zone, plus ~$12/year
  for the domain. Only needed if you want reminders sent from your own domain
  (recommended — see the deliverability note below).
- Leaving SES in sandbox and requesting production access: free, but sandbox
  restricts you to verified recipient addresses.

## What you get

- **Automatic reminders** at 7 days, 1 day, and day-of, sent whether or not a
  browser is open.
- **Gift links in the email** — Etsy and Amazon searches per person, with the
  query chosen from how they are filed (a "Sister" gets `gifts for sister`, and
  notes like "loves pottery" take priority).
- **Cloud sync** so the list survives a cleared browser and works on multiple
  devices.
- **Import** from `.ics`, `.vcf`, or CSV — Google Calendar, Apple Contacts,
  Outlook.
- **Export and backup** — CSV plus a lossless JSON backup with restore.
- **No login step** if you bake the household password in at build time.
- **Idempotent sends** — one marker per person, per year, per offset, so a retry
  or a double schedule fire never sends twice.

## Deploy it

### 1. Verify a sender address in SES

In the region you plan to use, verify either a domain (recommended) or a single
address:

```bash
aws sesv2 create-email-identity --email-identity yourdomain.com --region us-west-2
```

Then publish the DKIM records it gives you.

**Do not send as a `@gmail.com` address.** Gmail's DMARC policy tells receivers
to distrust mail claiming to be from `gmail.com` that was sent through SES, and
you cannot fix that because you do not control Gmail's DNS. Reminders will go
to spam. Use a domain you own.

New SES accounts are in sandbox mode, which only allows sending to verified
addresses — fine for a household, since you are emailing yourself. Request
production access if you need more.

### 2. Deploy

```bash
deploy/deploy.sh \
  --password 'something-long-and-unguessable' \
  --from birthdays@yourdomain.com \
  --to you@example.com \
  --origin https://yourname.github.io
```

That is the whole backend. The script packages both functions, uploads them to
a private code bucket it creates on first run, and creates the stack. It prints
your API endpoint at the end.

Re-run the same command to deploy a change. Anything you leave off keeps its
current value, so updating just the send hour is `--hour 7` on its own. Bundle
keys are content-addressed, so CloudFormation actually picks up edited code
instead of leaving the old version running.

It needs the AWS CLI. For zipping it uses whichever of `zip`, `python3`,
`python` or `powershell` you already have.

Useful extras: `--region`, `--stack`, `--timezone`, `--hour`, `--retention`,
`--app-url` (the link at the bottom of the reminder). `--help` lists them all.

`--origin` is required and must be one exact origin. It used to default to
`*`, which meant any site a signed-in user happened to visit could call your
API from their browser with their stored token attached.

Only the scrypt hash of the password ever reaches the running app, held in SSM
Parameter Store as a SecureString. It is not written to the stack outputs or to
any log.

One caveat worth stating plainly, because the previous wording here was too
generous: CloudFormation keeps the parameter values you passed in alongside the
stack, so the plain password can be read back by anyone in the account holding
`cloudformation:DescribeStackResource` on it. `NoEcho` hides the value in the
console, not from the API. Treat it as an account-level secret, and rotate it by
re-running the deploy with a new `--password`.

#### Or by hand

The template stands on its own if you would rather not run a script. Deploy it
with no `CodeBucket` and both functions come up as a placeholder that returns a
clear error, so the stack is valid before any code exists:

```bash
aws cloudformation deploy \
  --template-file deploy/template.yaml \
  --stack-name bdayapp \
  --capabilities CAPABILITY_IAM \
  --region us-west-2 \
  --parameter-overrides \
      HouseholdPassword='pick-something-long' \
      FromAddress='birthdays@yourdomain.com' \
      ToAddresses='you@example.com' \
      AllowedOrigin='https://yourname.github.io'
```

Then either push code with `aws lambda update-function-code`, or re-deploy
passing `CodeBucket`, `ApiCodeKey` and `ReminderCodeKey`. The console works
too: **Create stack → upload a template file**.

### 3. Point the front end at your API

Take the endpoint the script printed (`ApiEndpoint` in the stack outputs) and
give it to the build as `API_ENDPOINT`. On GitHub Pages that is a repository
secret of that name, which the included workflow reads:

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `API_ENDPOINT` | the `ApiEndpoint` output, e.g. `https://xxxxxxxx.execute-api.us-west-2.amazonaws.com` |
| `HOUSEHOLD_PASSWORD` | the same password you deployed with — optional, enables the no-login flow |

The endpoint is no longer hard-coded in `index.html`. Without `API_ENDPOINT`
the app still runs, but local-only: it stores birthdays in the browser, does
not sync, and no reminder will fire. The build logs a warning saying so.

Before setting `HOUSEHOLD_PASSWORD`, read the note in the root README: it is
baked into the published HTML in clear text, so on a public site anyone can
read it with view-source.

### 4. Send a test

```bash
aws lambda invoke --function-name bdayapp-reminder \
  --region us-west-2 --payload '{}' out.json && cat out.json
```

With nothing due you should see `{"sent":0,...,"reason":"nothing due"}`. Add a
birthday 7 days out and run it again to see `{"sent":1,...}`.

## Removing it

```bash
aws cloudformation delete-stack --stack-name bdayapp --region us-west-2
```

That deletes everything the template made, including the table and its data.
Export a backup from the app first if you want to keep the list.

The code bucket is created by the deploy script rather than by the template, so
the stack does not own it and will not remove it. Delete it yourself once the
stack is gone:

```bash
aws s3 rb "s3://bdayapp-code-$(aws sts get-caller-identity --query Account --output text)-us-west-2" --force
```

## What the template does not do

- **Verify SES for you.** Domain verification needs DNS records only you can
  publish.
- **Host the front end.** It is a static file; put it on Pages, S3, or anywhere.
- **Support multiple households.** There is one shared password and one
  `household` partition. It is a family utility, not a tenant system.
