# Deploy your own

This folder is the whole backend as one CloudFormation template. It creates the
database, both functions, the API, the Cognito sign-in, the daily schedule, and
the IAM roles in your own AWS account. Nothing here phones home to mine.

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
| Cognito (Essentials tier) | 1–2 monthly active users | $0.00 — first 10,000 MAU free |
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
- **Private sign-in** — Cognito's hosted page with a one-time code emailed to
  you. Invite-only: only the one or two addresses you name can sign in.
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

### 2. Create the stack

```bash
aws cloudformation deploy \
  --template-file deploy/template.yaml \
  --stack-name bdayapp \
  --capabilities CAPABILITY_IAM \
  --region us-west-2 \
  --parameter-overrides \
      SignInEmail='you@example.com' \
      SecondSignInEmail='partner@example.com' \
      SignInDomainPrefix='yourname-birthdays' \
      FromAddress='birthdays@yourdomain.com' \
      SesIdentity='yourdomain.com' \
      ToAddresses='you@example.com' \
      AllowedOrigin='https://yourname.github.io' \
      AppUrl='https://yourname.github.io/birthday-reminder-gifting-app/' \
      TimeZone='America/Chicago' \
      ReminderHour=8
```

`AllowedOrigin` is the origin alone (`https://yourname.github.io`) and pins
CORS. `AppUrl` is the full page URL; Cognito only ever sends people back there
after sign-in.

Or open the CloudFormation console, choose **Create stack → upload a template
file**, and fill in the same values.

### Finish setting up sign-in

The template creates each sign-in user without an invitation. Cognito leaves a
user created that way in `FORCE_CHANGE_PASSWORD`, and in that state it only
offers password sign-in, not the emailed code. Set a random permanent password
that nobody is told, once per user. The stack's `SetPasswordCommand` output has
the command ready to paste:

```bash
aws cognito-idp admin-set-user-password --region us-west-2 \
  --user-pool-id us-west-2_XXXXXXXXX --permanent \
  --username you@example.com --password "$(openssl rand -base64 24)Aa1"
```

Run it again with `--username partner@example.com` if you set a second user.

Codes are emailed through your SES identity, so in the SES sandbox each
sign-in address must be verified too.

### 3. Upload the function code

The template creates both Lambdas with a placeholder that returns a clear error,
so the stack is valid before you have built anything. Push the real code:

```bash
# API
cp backend/index.mjs index.mjs && zip -q api.zip index.mjs && rm index.mjs
aws lambda update-function-code --function-name bdayapp-api \
  --zip-file fileb://api.zip --region us-west-2

# Reminder
cp backend/reminder.mjs index.mjs && zip -q reminder.zip index.mjs && rm index.mjs
aws lambda update-function-code --function-name bdayapp-reminder \
  --zip-file fileb://reminder.zip --region us-west-2
```

Both files import only the AWS SDK, which the Node 20 runtime already provides,
so there is no `npm install` and no bundler.

### 4. Point the front end at your stack

Take `ApiEndpoint`, `SignInDomain` and `SignInClientId` from the stack outputs
and set them in `index.html`:

```js
const API = 'https://xxxxxxxx.execute-api.us-west-2.amazonaws.com';
const AUTH_DOMAIN = 'https://yourname-birthdays.auth.us-west-2.amazoncognito.com';
const AUTH_CLIENT = 'xxxxxxxxxxxxxxxxxxxxxxxxxx';
```

Put both the API and the sign-in domain in the page's `connect-src` CSP at the
top of `index.html`, or the browser will block the calls.

Then deploy `index.html` to the exact `AppUrl` you gave the stack. The included
GitHub Actions workflow publishes it to Pages; see the root README.

### 5. Check it

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

## What the template does not do

- **Verify SES for you.** Domain verification needs DNS records only you can
  publish.
- **Host the front end.** It is a static file; put it on Pages, S3, or anywhere.
- **Support multiple households.** Everyone who can sign in shares one
  `household` partition. It is a family utility, not a tenant system.
