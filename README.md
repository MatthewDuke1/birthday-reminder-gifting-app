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
backend/index.mjs     API Lambda: POST /auth, GET /friends, PUT /friends
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

One shared household password. The browser posts it to `/auth`, the Lambda
compares it against a scrypt hash held in SSM, and hands back an HMAC-signed
token good for 30 days. Eight failed attempts from an IP triggers a lockout.

**You should never see a login.** If `HOUSEHOLD_PASSWORD` is set as a repo
secret, the build bakes it into the page and the app signs itself in on load.
Add a birthday and it syncs; there is no setup step.

That does mean the password ships in the published HTML in clear text, readable
by anyone who views source. It is an accepted trade here: the data is a family
birthday list, the API is rate limited, and the lockout still applies. Do not
reuse the pattern for anything that matters more than this does.

Skip the secret and the app falls back to a manual sign-in form. Everything
still works locally, but birthdays added while signed out never reach the
reminder.

It is scoped for a household, not a tenant system. There are no user accounts.

## Running it

### Use the hosted one

Open the live link, sign in with the household password, and you are done.

### Deploy the front end yourself

GitHub Pages builds from `.github/workflows/deploy-pages.yml`. It substitutes the
`%%EMAILJS_*%%` placeholders at build time and publishes `dist/index.html`.

1. **Settings → Secrets and variables → Actions**, add:

   | Secret | Example | Needed for |
   |---|---|---|
   | `HOUSEHOLD_PASSWORD` | your household password | silent sign-in, so reminders work with no setup |
   | `EMAILJS_PUBLIC_KEY` | your EmailJS public key | the in-app "send heads-up now" button |
   | `EMAILJS_SERVICE_ID` | `service_xxxxxxx` | same |
   | `EMAILJS_TEMPLATE_ID` | `template_xxxxxxx` | same |

   `HOUSEHOLD_PASSWORD` is the one that matters. Without it the app requires a
   manual sign-in, and a birthday added while signed out will not generate a
   reminder. The build logs a warning if the secret is missing.

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

- One household, one password. No multi-user support.
- 2,000 contacts, enforced on both the client and the API.
- Reminder recipients are configured on the Lambda, not in the UI.
- Birthday emails depend on EmailJS quota, and a failure surfaces an
  "Open in mail app" fallback rather than failing silently.
