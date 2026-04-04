# 🎂 Birthday Email Automator

AI-written birthday emails + heads-up reminders + gift search + Google Calendar import.

## Features

- **Friends list** — Add people with name, email, birthday, relationship, and personal notes
- **Relationship categories** — Mom, Dad, Spouse, Best friend, Colleague, and more — with colour-coded avatars
- **Google Calendar import** — Scans all your calendars for birthday events and imports them in one click
- **Gift search** — Search Etsy & Amazon for gifts per person, with smart defaults based on their notes
- **AI gift ideas** — Ask Claude for personalised gift suggestions right from the app
- **Birthday emails** — Claude writes personalised emails; EmailJS delivers them from your browser
- **Heads-up reminders** — Get an email to yourself X days before each birthday
- **Filter by relationship** — View just family, friends, colleagues, etc.

## Deploy to GitHub Pages

1. Fork or push this repo to GitHub (make sure it's public, or enable Pages on private repos with a paid plan)
2. Go to **Settings → Pages** → set Source to **GitHub Actions**
3. Push to `main` — your site goes live at `https://<username>.github.io/<repo-name>`

## How to use

1. Open the app and go to **Add friend** or **Import from calendar**
2. Set your own email in **Notifications** for heads-up reminders
3. Each day, open the app and click **Copy birthday prompt** in the Send tab
4. Paste the prompt into [Claude](https://claude.ai), copy the reply
5. Paste Claude's reply back into the app and hit **Send** — EmailJS delivers it

## EmailJS setup

The app is pre-configured. To use your own EmailJS account, update these three values in `index.html`:

```js
const EJSPUB = 'your_public_key';
const EJSSVC = 'your_service_id';
const EJSTPL = 'your_template_id';
```

Your EmailJS template must include these variables: `to_name`, `to_email`, `subject`, `message`.

## Google Calendar import

The calendar scan uses the Claude API with the Google Calendar MCP connector.
This only works when running inside [Claude.ai](https://claude.ai) with the Google Calendar connector enabled.
On a standalone deployment the scan button will show a connection error — this is expected.

## Notes

- All friend data is stored in your browser's `localStorage` — nothing is sent to any server
- The EmailJS public key is safe to expose in client-side code
- Imported friends from Google Calendar are marked with a 📅 badge
