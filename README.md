# Birthday Email Automator

A small household app that remembers birthdays, emails a reminder a week out, and
helps you write the message. One HTML file for the front end, a thin AWS backend
so the reminders fire whether or not anyone opens a browser.

Live at **https://matthewduke1.github.io/birthday-reminder-gifting-app/**

---

## What it does

- **Tracks birthdays** — name, email, date, relationship, notes.
- **Emails a reminder automatically** at 7 days out, 1 day out, and on the day.
  A scheduler runs this; no browser needs to be open.
- **Composes the birthday email** and sends it through EmailJS from your own account.
- **Gift search** per contact.
- **Imports** from `.ics`, `.vcf`, or CSV — Google Calendar, Apple Contacts, Outlook.
- **Syncs to the cloud** so the list survives a cleared browser and works on more
  than one device.
- **Exports CSV** any time, plus a lossless JSON backup.

## How it is put together

```
index.html            the entire front end -- no build step, no framework
backend/index.mjs     API Lambda: GET /friends, PUT /friends
backend/reminder.mjs  reminder Lambda, run daily by EventBridge Scheduler
backend/*.json        IAM trust and policy documents
deploy-aws.sh         optional S3 + CloudFront deploy
```

Backend lives in **us-west-2**, deliberately separate from any other stack.

| Piece | What it is |
|---|---|
| Storage | DynamoDB `bdayapp-friends`, point-in-time recovery on, single `household` partition |
| API | Lambda `bdayapp-api` behind an HTTP API |
| Reminder | Lambda `bdayapp-reminder`, EventBridge Scheduler, 8am America/Chicago |
| Email (reminders) | SES, from `Birthday Reminders <birthdays@the-duke.org>` |
| Email (birthday messages) | EmailJS, from the browser, using your own credentials |

Two different mail paths on purpose. Reminders come from an authenticated domain
so they land in the inbox. The birthday message itself goes through EmailJS so it
comes from *you*, not from a server.

## Why the reminder is a window, not a date

The first version only fired when somebody opened the app and clicked a button,
and it matched at exactly seven days out. Miss that morning and the birthday
passed silently.

Now a scheduler runs daily and matches a **window** — 7 days, 1 day, and day-of —
with a sent-marker so nobody gets the same reminder twice. A scheduler that has
one bad morning still catches the birthday on a later pass.

This is also why the data had to move out of `localStorage`: a server-side job
cannot read a browser.

## Auth

Sign-in is Amazon Cognito. The app sends you to Cognito's hosted sign-in page,
you enter your email, and Cognito emails you a one-time code from the same SES
sender as the reminders. There is no password to remember.

- **Invite-only.** The user pool holds exactly the household's accounts, and
  sign-up is turned off. Anyone else who finds the page gets a sign-in screen
  and nothing more.
- **Checked before the code runs.** API Gateway's JWT authorizer rejects any
  request without a valid access token from this pool before the Lambda is
  invoked.
- **Signed in for a year per device.** Access tokens last an hour and are
  renewed silently from a 365-day refresh token. Signing out revokes the
  refresh token and ends the Cognito session.
- **Works offline once signed in.** The list renders from `localStorage`, and
  sync catches up when the network is back.

This replaced a shared household password that was baked into the published
HTML, where anyone who viewed source could read it.

To add or remove someone, create or delete them in the Cognito user pool. A new
user needs a permanent password set once so the emailed code works (see
`SetPasswordCommand` in [`deploy/README.md`](deploy/README.md)); nobody is ever
told that password.

## Running it

### Use the hosted one

Open the live link, choose **Sign in with email**, and enter the code Cognito
emails you. Only the household's own accounts can sign in.

### Deploy the front end yourself

GitHub Pages builds from `.github/workflows/deploy-pages.yml`. It substitutes the
`%%EMAILJS_*%%` placeholders at build time and publishes `dist/index.html`.

1. **Settings → Secrets and variables → Actions**, add:

   | Secret | Example | Needed for |
   |---|---|---|
   | `EMAILJS_PUBLIC_KEY` | your EmailJS public key | the in-app "send heads-up now" button |
   | `EMAILJS_SERVICE_ID` | `service_xxxxxxx` | same |
   | `EMAILJS_TEMPLATE_ID` | `template_xxxxxxx` | same |

2. **Settings → Pages → Source → GitHub Actions**
3. Push to `main`.

The secrets are optional. Skip them and the placeholders stay inert — anyone
using the app can paste their own keys into the Settings tab instead.

### S3 instead of Pages

```bash
cp .env.example .env     # fill in EmailJS keys + S3_BUCKET
chmod +x deploy-aws.sh
./deploy-aws.sh
```

### Local preview

```bash
source .env
sed "s|%%EMAILJS_PUBLIC_KEY%%|$EMAILJS_PUBLIC_KEY|g; \
     s|%%EMAILJS_SERVICE_ID%%|$EMAILJS_SERVICE_ID|g; \
     s|%%EMAILJS_TEMPLATE_ID%%|$EMAILJS_TEMPLATE_ID|g" \
  index.html > index.local.html
open index.local.html
```

Note that `localStorage` is origin-scoped: a list built at `file://` is invisible
to the deployed page and vice versa. Cloud sync is what makes the two agree.

## EmailJS template

Create a template using these variables. Nothing else is needed.

| Variable | Meaning |
|---|---|
| `{{to_email}}` | recipient address |
| `{{subject}}` | subject line |
| `{{message}}` | body |
| `{{to_name}}` | recipient name, optional |

## Import formats

**Contacts and calendars**

| Source | Path |
|---|---|
| Google Contacts | Contacts → Export → vCard (.vcf) |
| Google Calendar | Settings → Import & Export → Export (.ics) |
| Apple Contacts | File → Export → Export vCard |
| Outlook | File → Open & Export → Import/Export → Export to a file |

**CSV** — header row required, column order flexible:

```
Name, Email, Birthday, Relationship, Notes
```

Dates accepted as `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`, or `January 5 1990`.

## Email deliverability

Reminders send from a domain we control and have authenticated with SPF, DKIM,
and DMARC. Sending *as* a `gmail.com` address through SES does not work —
Gmail's own DMARC policy tells receivers to distrust it, and the DNS for
`gmail.com` is not ours to fix. The full write-up, including the DNS records,
is in [`backend/EMAIL-SETUP.md`](backend/EMAIL-SETUP.md).

## Limits

- One household sharing one list. Everyone who can sign in sees the same
  birthdays; there are no per-person lists.
- 2,000 contacts, enforced on both the client and the API.
- Reminder recipients are configured on the Lambda, not in the UI.
- Birthday emails depend on EmailJS quota, and a failure surfaces an
  "Open in mail app" fallback rather than failing silently.
