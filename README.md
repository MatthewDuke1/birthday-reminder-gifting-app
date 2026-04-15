# 🎂 Birthday Email Automator

Compose & send birthday emails · ICS/CSV import · Gift search · Heads-up reminders

---

## What's new in this version

- **ICS & vCard import** — upload `.ics` or `.vcf` files from Google Calendar, Apple Contacts, Outlook, etc.
- **CSV import** — flexible column detection, multiple date formats, downloadable template
- **Settings tab** — configure EmailJS credentials in the UI (no rebuild needed)
- **CORS error handling** — clear diagnosis of network/quota/credential errors with "Open in mail app" fallback
- **Export CSV** — back up your friends list at any time

---

## Deploy to GitHub Pages

### 1. Add repository secrets *(optional — you can also set keys in the app's Settings tab)*

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret name             | Value                   |
|-------------------------|-------------------------|
| `EMAILJS_PUBLIC_KEY`    | Your EmailJS public key |
| `EMAILJS_SERVICE_ID`    | e.g. `service_xxxxxxx`  |
| `EMAILJS_TEMPLATE_ID`   | e.g. `template_xxxxxxx` |

### 2. Enable GitHub Pages

**Settings → Pages → Source → GitHub Actions**

### 3. Push to main → auto-deploys

The workflow at `.github/workflows/deploy-pages.yml` substitutes the `%%EMAILJS_*%%` placeholders at build time, writes the result to `dist/index.html`, and publishes it via `actions/deploy-pages`. If you'd rather keep credentials out of GitHub entirely, skip the secrets — the placeholders are harmless and users can paste their own keys into the app's Settings tab.

Live at **https://matthewduke1.github.io/birthday-reminder-gifting-app/**

---

## EmailJS template setup

Create a template with these variables:
- `{{to_email}}` — recipient address
- `{{subject}}` — subject line
- `{{message}}` — email body
- `{{to_name}}` — recipient name (optional)

That's it. No other variables needed.

---

## Import formats

### ICS / vCard
- **Google Contacts:** Contacts → Export → vCard (.vcf)
- **Google Calendar:** Calendar Settings → Import & Export → Export (.ics)
- **Apple Contacts:** File → Export → Export vCard
- **Outlook:** File → Open & Export → Import/Export → Export to a file

### CSV columns (header row required, order flexible)
```
Name, Email, Birthday, Relationship, Notes
```
Date formats accepted: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`, `January 5 1990`

---

## AWS deploy

```bash
cp .env.example .env
chmod +x deploy-aws.sh
./deploy-aws.sh
```

---

## Local preview

```bash
source .env
sed "s|%%EMAILJS_PUBLIC_KEY%%|$EMAILJS_PUBLIC_KEY|g; \
     s|%%EMAILJS_SERVICE_ID%%|$EMAILJS_SERVICE_ID|g; \
     s|%%EMAILJS_TEMPLATE_ID%%|$EMAILJS_TEMPLATE_ID|g" \
  index.html > index.local.html
open index.local.html
```
