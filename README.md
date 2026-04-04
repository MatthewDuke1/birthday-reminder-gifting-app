# 🎂 Birthday Email Automator

Compose & send birthday emails · Gift search (Etsy & Amazon) · Google Calendar import · Heads-up reminders

---

## Features

- **Friends list** — name, email, birthday, relationship, notes — with colour-coded avatars
- **Relationship categories** — Mom, Dad, Spouse, Best friend, Colleague, and more
- **Compose & send** — write your own email, pick recipients from your friends list or type any address, send via EmailJS
- **Starter templates** — Quick & cheerful, Warm & heartfelt, Funny & casual
- **Gift search** — Etsy & Amazon search per friend, with smart defaults from their notes
- **Google Calendar import** — scans all calendars for birthday events (works inside Claude.ai)
- **Heads-up reminders** — sends you an email X days before upcoming birthdays
- **Filter by relationship** — view just family, friends, colleagues, etc.

---

## Deploy to GitHub Pages

### 1. Add repository secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name             | Value                     |
|-------------------------|---------------------------|
| `EMAILJS_PUBLIC_KEY`    | Your EmailJS public key   |
| `EMAILJS_SERVICE_ID`    | e.g. `service_xxxxxxx`    |
| `EMAILJS_TEMPLATE_ID`   | e.g. `template_xxxxxxx`   |

### 2. Enable GitHub Pages

**Settings → Pages → Source → GitHub Actions**

### 3. Push to main

The workflow substitutes the secret placeholders and deploys automatically.
Live at: `https://<username>.github.io/<repo-name>`

---

## Deploy to AWS (S3 + CloudFront)

```bash
cp .env.example .env   # fill in your values
chmod +x deploy-aws.sh
./deploy-aws.sh
```

---

## EmailJS template variables

Your template must include: `{{to_name}}`, `{{to_email}}`, `{{subject}}`, `{{message}}`

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

---

## Notes

- All data stored in browser `localStorage` — nothing sent to any server
- Google Calendar import only works inside Claude.ai with the connector enabled
- EmailJS public key is safe to expose client-side (restrict by domain in EmailJS dashboard)
