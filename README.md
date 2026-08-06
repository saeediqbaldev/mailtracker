# Xeven MTracker

A self-hosted email read-tracking system for Zoho Mail, Gmail, and Hostinger Webmail — a
tracking-pixel + link-tracking backend with a dashboard, plus a browser extension that
injects the tracking pixel into emails you compose in any of the three webmail UIs.

It is modeled on tools like Mailtrack/Mailtracker for Gmail, but none of these three
webmail UIs has an official "add-on" API for compose — so the extension works by
modifying the compose window's HTML in your browser before you hit Send. Read the
**Limitations** section below before relying on this for anything important.

## What's in this repo

```
zoho-mail-tracker/
├── docker-compose.yml       # app + Postgres, deploy this as-is on Coolify
├── .env.example              # copy to .env and fill in
├── server/                   # Node/Express backend + dashboard (single container)
│   ├── Dockerfile
│   ├── src/                  # API: tracking pixel, click redirect, dashboard API
│   └── public/                # dashboard frontend (plain HTML/CSS/JS, no build step)
└── extension/                 # Chrome/Edge (Manifest V3) extension — Zoho Mail + Gmail + Hostinger
```

## 1. Deploying the backend + dashboard (Coolify)

1. Push this repo to your own git provider (GitHub/GitLab/Gitea — whatever Coolify reads from).
2. In Coolify: **New Resource → Docker Compose**, point it at this repo, root = repo root
   (where `docker-compose.yml` lives).
3. Copy `.env.example` to `.env` and fill in real values (see below). In Coolify you can
   paste these as the resource's environment variables instead of committing a `.env` file
   — **do not commit real secrets to git**.
4. Set the domain for the `app` service in Coolify (e.g. `track.yourdomain.com`) and let
   Coolify issue SSL for it (it proxies to the container's port `3000` automatically).
5. Set `APP_BASE_URL` in your env to that exact public URL (`https://track.yourdomain.com`)
   — this is the base URL baked into every tracking pixel and click link, so it must be
   correct before you start sending tracked mail.
6. Deploy. On first boot the app creates its own database tables — no separate migration
   step needed.
7. Visit `https://track.yourdomain.com`, log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from
   your env, and confirm the dashboard loads (it'll just be empty until you send a tracked
   email).

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the Node app listens on inside the container (leave at `3000` — Coolify/Traefik maps your domain to it). |
| `APP_BASE_URL` | The public HTTPS URL of this app. Baked into every pixel/click URL. Must match your Coolify domain exactly. |
| `JWT_SECRET` | Long random string, signs the dashboard login session. Generate with `openssl rand -hex 32`. |
| `API_KEY` | Long random string, the credential the browser extension uses to talk to the backend. Generate with `openssl rand -hex 32`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Login for the dashboard (single-user tool — one admin account). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials for the bundled Postgres container. |
| `DATABASE_URL` | Full connection string the app uses — keep it consistent with the Postgres vars above (`postgres://USER:PASSWORD@db:5432/DB`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Your Zoho Mail SMTP credentials, used to send email notifications (see **Email notifications** below). Not required if you leave email notifications off in Settings. |

## 2. Installing the browser extension

This extension is pre-configured for `https://journal.xevenpixels.com` with its
API key already embedded in `extension/background.js` — you don't need to open
the options page or type anything in. Just load it:

1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode** → **Load
   unpacked** → select the `extension/` folder.
2. That's it — open Zoho Mail, Gmail, **or Hostinger Webmail** and start composing.

Since v3.0.0 the same extension works on all three. Chrome will ask you to accept
the added `mail.google.com` and `mail.hostinger.com` host permissions the first time you
load/update it — that's expected, it's what lets those content scripts run there.

If you ever redeploy this backend at a *different* domain, or rotate the API
key, update the two `DEFAULT_*` constants at the top of `extension/background.js`
before reloading the extension (or just use the Options page to override them
per-browser without touching the source).

**After updating the extension** (reloading it in `chrome://extensions`),
fully refresh any Zoho Mail, Gmail, or Hostinger tabs that were already open —
otherwise you'll see an "Extension was updated" error, because the tab's old connection
to the extension is gone. This is normal Chrome behavior, not a bug.

## How tracking works

- **Opens**: when you enable tracking on a compose window, the extension asks the backend
  for a tracking ID and inserts an invisible `<img>` pixel pointing at
  `APP_BASE_URL/t/<id>/pixel.png` into the email body. When the recipient's mail client
  loads images (most do, automatically or on click), that request hits the backend, which
  logs an "open" event (timestamp, IP, user agent) and flips the email's status to
  **Opened**.
- **Link clicks**: the extension rewrites `http(s)://` links in the body to go through
  `APP_BASE_URL/t/<id>/click?...`, which logs the click and then redirects the recipient
  to the real destination.
- **Dashboard**: shows every tracked email, aggregate stats (sent / opened / open rate),
  per-email open/click history, and filters by status, recipient, and date.

Zoho, Gmail, and Hostinger each get their own **Tracking / History / Reports / Alerts** tab
on the dashboard — this is a single dashboard/database, just filtered by which mail client
an email was sent from, so it's easy to keep the three totally separate at a glance.

### Zoho Mail vs. Gmail vs. Hostinger: what's different under the hood

Same idea, different DOM to work with:

| | Zoho Mail | Gmail | Hostinger Webmail |
|---|---|---|---|
| Compose editor | Inside an `<iframe>` (Zoho's rich-text editor) | A plain `contenteditable` `<div>` on the page itself — no iframe | Inside an `<iframe data-qa="composer-content-iframe">` — same iframe-based architecture as Zoho |
| Recipients | Scraped from chip text/attributes near the To field | Multi-attribute scan (title/aria-label/data-hovercard-id/etc.) near the To/Cc/Bcc fields | Plain text in `input#to` (comma/semicolon-separated), with a chip-scan fallback |
| Subject | `input[aria-label*="subject"]` | `input[name="subjectbox"]` | `input#subject` / `input[data-qa="composer-subject"]` |
| Content script | `extension/content-script.js` | `extension/content-script-gmail.js` | `extension/content-script-hostinger.js` |

All three send a `provider` field (`'zoho'`, `'gmail'`, or `'hostinger'`) to the backend
when a tracked email is created, which is how the dashboard knows which tab it belongs to.
**Gmail detection assumes an English-language Gmail UI** (it looks for aria-labels like
"Message Body" and "Send") — if your Gmail is set to another language, those strings in
`content-script-gmail.js` will need updating to match.

### Hostinger: what's confirmed vs. guessed

All four core elements are now confirmed against real DOM: **To** (`input#to` /
`data-qa="composer-to-input"`), **Subject** (`input#subject` /
`data-qa="composer-subject"`), **body** (an `<iframe data-qa="composer-content-iframe">` —
same overall architecture as Zoho: a separate document loaded in an iframe, read via
`iframe.contentDocument.body`), and **Send** (a `<button>` whose text is "Send").

What's still a guess is exactly *where* the Track toggle attaches (it looks for
`[role='toolbar']` or a `class*="toolbar"` element near the compose window, falling back to
a floating button positioned over the container if neither exists) and exactly which
ancestor is "the" compose window container (it walks up from the iframe requiring both a
Send button and the To field to be present, same strategy as the Zoho script). If the
toggle appears in an odd spot, or not at all, open the console (F12) right before sending —
the script logs `[Xeven MTracker/Hostinger] ...` with exactly what it found.

## Notes on self-opens

Right after you send an email, your own mail client typically loads the sent
copy's images automatically when you view your Sent folder — that would hit
the tracking pixel from your own IP and falsely mark the email "Opened"
before anyone actually opened it. The backend filters this out two ways: it
ignores pixel hits coming from the same IP the email was sent from, and it
ignores any hit within `OPEN_GRACE_SECONDS` (default 8s) of send time. Real
recipient opens go through normally; only your own immediate self-view is
suppressed.

## Live updates

The dashboard auto-refreshes on an interval you control from **Settings → Auto-refresh**
(off, 15s, 30s, 1m, 2m, or 5m — 15s by default). There's also a manual **↻ Refresh**
button next to the filters on the Tracking tab for an immediate check. Clicking any of the
Sent/Opened/Unopened/Clicked stat cards filters the table to just those records (Opened
includes Clicked, since a click implies the message was opened).

## Dashboard layout: Zoho Mail / Gmail / Hostinger, each with four tabs

The top-level tabs are **Zoho Mail**, **Gmail**, **Hostinger**, and **Settings**. Settings
is account-wide (SMTP creds, refresh interval); the three mail-client tabs are otherwise
completely separate views into the same database, filtered by which extension content
script created the record. Inside each one:

- **Tracking** — the per-email ledger: subject, recipients, status, open/click counts,
  filters, bulk delete. This is what used to just be called "Ledger."
- **History** — a flat, chronological log of every individual open and click event (not
  grouped by email), filterable by type/subject/date range. Useful for "what happened
  today" in a way the per-email Tracking view doesn't show directly.
- **Reports** — the analytics view (see below).
- **Alerts** — the notifications view (see below), with its own unread badge; both
  provider tabs also show their own unread badge so you can tell at a glance which mailbox
  has something new without switching to it.

## Reports tab

A time-boxed overview instead of the raw ledger, scoped to whichever provider tab you're on:

- **Range filter** — 1D / 7D / 30D / 90D / 1Y buttons switch every card, chart, and the
  heatmap below to that window.
- **Data cards** — Sent, Opens, Clicks, Unique opened, and Open rate for the selected range.
- **Opens & clicks over time** — a line chart (hourly buckets for 1D, daily for 7D/30D/90D,
  monthly for 1Y).
- **Engagement heatmap** — a day-of-week × hour grid of combined open + click events, so you
  can see at a glance when your recipients are actually reading mail (e.g. "most opens land
  Tue–Thu, 9–11am").

## Alerts tab

Every time an email is opened for the **first** time, or a link is clicked (every click,
since repeat clicks are still meaningful), a notification record is created:

- A 🔔 bell icon on each row — filled/red when unread, click it to toggle read/unread.
- Filter by type (Open/Click) or unread-only, and **Mark all read**.
- Full CRUD: delete a single notification (✕) or select several with the checkboxes and
  **Delete selected**. Deleting a notification never deletes the underlying tracked email.
- An unread-count badge sits on the "Notifications" tab itself and updates on every
  auto-refresh tick.

Note on repeat opens: the pixel still counts every open toward the email's `open_count` and
`last_opened_at` in the Ledger — only the **Notifications page and email alert** are limited
to the first open, to avoid a chatty inbox every time someone re-reads a message.

## Email notifications

Turn this on from **Settings → Email notifications**: check "Enable email notifications" and
set the address to receive them at, then **Save settings**.

The server sends these via your own Zoho Mail account over SMTP, so you also need the
`SMTP_*` variables filled in in `.env`:

```
SMTP_HOST=smtp.zoho.com
SMTP_PORT=465
SMTP_USER=you@yourdomain.com
SMTP_PASS=your-zoho-app-password
SMTP_FROM=you@yourdomain.com
```

Use a Zoho **App Password**, not your normal login password — generate one at
[Zoho Account → Security → App Passwords](https://accounts.zoho.com/home#security/app-passwords)
if two-factor auth is enabled on the account (Zoho requires this for SMTP login either way on
most orgs). If your Zoho org sits on a regional domain (`smtp.zoho.eu`, `smtp.zoho.in`, etc.),
use that host instead of `smtp.zoho.com`.

If `SMTP_*` isn't configured, the feature silently no-ops (logs a warning, doesn't crash) even
if you switch it on in Settings — the toggle only controls whether the *app* wants to send,
the env vars control whether it *can*.

## WhatsApp notifications (not wired up yet)

The Settings page has a placeholder noting this. To add it later, the cleanest hook is
`server/src/notify.js` — add a `sendWhatsAppNotification(text)` function there and call it
alongside `sendEmailNotification(...)` in `server/src/routes/track.js` (both call sites are
already marked with comments). Two practical options for a personal number like
`+923049297788`:

- **CallMeBot** (free, quickest for a single personal number): message their WhatsApp bot
  once to get an API key, then notify with a plain `GET` request:
  `https://api.callmebot.com/whatsapp.php?phone=923049297788&text=<url-encoded message>&apikey=<your key>`.
  No business approval needed, but it's rate-limited and meant for personal/low-volume use.
- **Twilio WhatsApp Business API** (paid, production-grade): requires a Twilio account, a
  WhatsApp-enabled sender, and (outside a 24h reply window) pre-approved message templates.
  More setup, but more reliable for anything beyond personal use.

## Managing records

Each tracked email in the dashboard supports:
- **Read** — click a row to see its full open/click history.
- **Update** — add a free-text note in the detail panel (e.g. "resend of Q3 proposal").
- **Delete** — remove a single record from its row (✕) or the detail panel,
  or select multiple rows with the checkboxes and use **Delete selected**.
  Deleting an email also removes its open/click history (cascading delete).

## Limitations (read this before relying on it)

- **Per-recipient status on multi-recipient emails is not possible with pixel tracking.**
  If you send one email to three people, the pixel can't tell you *which* of them opened
  it — only that *someone's* mail client loaded the image. The dashboard shows this
  honestly as one aggregate status per sent email, not a false per-person breakdown. If you
  need true per-person read receipts, send separate emails per recipient (one row per send).
- **Image blocking defeats it.** Many mail clients (and privacy-focused ones especially)
  block remote images by default, in which case an actual open won't register. This is a
  known limitation of every pixel-based tracker, including the Gmail tools this is modeled on.
- **The extension depends on each provider's compose DOM.** Zoho, Gmail, or Hostinger can
  change their web UI's HTML/CSS at any time, which can break the toolbar-button injection
  or the send-button hook. All three content scripts are written defensively with
  fallbacks, but if one stops finding the compose body, tracking silently won't attach for
  that provider — check that the "Track" toggle appears before relying on it, especially
  after a UI update. The three content scripts are independent, so a breakage in one
  doesn't affect the others.
- **Gmail detection assumes an English-language Gmail UI.** It looks for aria-label text
  like "Message Body" and "Send" — a non-English Gmail interface will need those strings
  updated in `extension/content-script-gmail.js` (see the "Zoho Mail vs. Gmail vs.
  Hostinger" section above).
- **Hostinger's toggle attach point and exact container boundaries are the one remaining
  soft spot** (see "Hostinger: what's confirmed vs. guessed" above) — the core fields
  (To/Subject/body/Send) are confirmed against real markup, but the ancestor-walk used to
  find "the compose window" as a whole is a heuristic like the other two providers'.
- **This is a single-admin, self-hosted tool**, not a multi-tenant SaaS. It's meant for
  one person or team behind one login.
- **Disclose tracking to recipients where required.** Some jurisdictions and email
  policies require disclosing that a message is tracked (open receipts, tracking pixels).
  That's on you to check for your use case — this repo doesn't handle consent/disclosure.
