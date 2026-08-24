# Relay — Alternate-Day Email Scheduler

Two parts:

1. **`index.html`** — open it in a browser. Build your recipient list, write
   the message, set the schedule (default: every 2 days), and export the
   queue as `email-schedule.csv`.
2. **`backend-server.js`** — a small Node service that actually sends the
   queued emails on schedule, through a real transactional email provider.

## Why two parts?

Browsers can't open outbound SMTP connections, and an email-provider API key
pasted into client-side JavaScript is visible to anyone who views the page
source. So the browser page plans the schedule; a small server (or a
scheduled job) does the sending. This isn't extra caution for its own sake —
it's the only way to send real mail from a web app at all.

## Getting real mail delivered (not flagged)

There's no trick or setting that lets bulk mail bypass spam filters —
filters are specifically built to catch anything that tries. What actually
works is sending mail that looks like what it is: wanted, from a real
sender, in reasonable volume. Concretely:

- **Only mail people who opted in** — a registration form, a newsletter
  sign-up, existing patients who agreed to updates. This matters more than
  any technical setting.
- **Authenticate your sending domain**: SPF, DKIM, and DMARC DNS records.
  Your email provider (Brevo, SendGrid, SES, Postmark) walks you through
  this once; without it, most inboxes distrust the mail by default.
- **Warm up a new domain or provider account**: start with small volumes
  and ramp up over 1–2 weeks rather than mailing your full list on day one.
- **Throttle and space sends** — which is exactly what the alternate-day
  schedule and per-send batch size in `index.html` are for.
- **Always include a working unsubscribe link and your real organization
  address** — both are legal requirements in most jurisdictions (Nigeria's
  NDPR, US CAN-SPAM, EU/UK equivalents) and inbox providers check for them.
- **Honor unsubscribes immediately** and keep your list clean of bounces —
  repeated sends to dead or complaining addresses is the single biggest
  driver of a domain getting blocklisted.

## Setup

```bash
npm install express node-cron csv-parse nodemailer dotenv
```

Create a `.env` file next to `backend-server.js`:

```
BREVO_API_KEY=your_api_key
FROM_EMAIL=clinic@yourdomain.com
FROM_NAME=Cityview Hospital Clinic
REPLY_TO=clinic@yourdomain.com
UNSUBSCRIBE_BASE_URL=https://yourdomain.com/unsubscribe
```

Before running for real, open `backend-server.js` and wire up
`recipientsForBatch()` to your actual list of opted-in contacts (a
database, a Google Sheet export, your registration-form responses) — the
CSV from the browser page only stores how many recipients a batch has, not
their addresses, so this step is required.

Then:

```bash
node backend-server.js
```

It checks hourly for any queued send whose date has arrived and sends it in
throttled batches, logging what's gone out in `sent-log.json` so nothing
double-sends on restart.

## Swapping providers

`sendBatch()` in `backend-server.js` is the only function tied to Brevo.
SendGrid, Amazon SES, Postmark, and Mailgun all have similar single-send
REST APIs or SDKs — replace the `fetch()` call with theirs and everything
else (batching, throttling, footer/unsubscribe injection, scheduling)
stays the same.
