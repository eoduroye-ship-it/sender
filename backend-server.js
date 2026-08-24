/**
 * Relay — email schedule runner
 * -----------------------------------------------------------------------
 * Reads email-schedule.csv (exported from index.html) and sends each
 * queued send on its scheduled date, in throttled batches, through a
 * real transactional email provider.
 *
 * Why a backend at all: browsers can't open raw SMTP connections, and an
 * API key pasted into client-side JS is public the moment the page loads.
 * This script is meant to run on a small always-on server (Render,
 * Railway, a VPS, etc.) or as a scheduled job.
 *
 * This uses Brevo (formerly Sendinblue) as the example provider because
 * it has a workable free tier for a clinic-sized list, but any
 * transactional provider (SendGrid, Amazon SES, Postmark, Mailgun) works
 * the same way — swap out the sendBatch() function.
 *
 * Setup:
 *   npm install express node-cron csv-parse nodemailer dotenv
 *   Create a .env file with:
 *     BREVO_API_KEY=xxxx
 *     FROM_EMAIL=clinic@yourdomain.com
 *     FROM_NAME=Cityview Hospital Clinic
 *     REPLY_TO=clinic@yourdomain.com
 *     UNSUBSCRIBE_BASE_URL=https://yourdomain.com/unsubscribe
 *   node backend-server.js
 *
 * IMPORTANT — do this once with your provider before sending real volume:
 *   1. Verify your sending domain and add its SPF + DKIM DNS records.
 *   2. Add a DMARC record.
 *   3. "Warm up" a new domain: send small volumes for the first 1-2 weeks
 *      before ramping to full list size. Providers throttle/flag sudden
 *      jumps from a brand-new domain regardless of what sends the mail.
 *   4. Keep an honest unsubscribe list and never re-mail people who opt out.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { parse } = require('csv-parse/sync');
require('dotenv').config();

const CSV_PATH = process.env.SCHEDULE_CSV || path.join(__dirname, 'email-schedule.csv');
const SENT_LOG = path.join(__dirname, 'sent-log.json');
const BATCH_DELAY_MS = 2000; // pause between batches within one send, to avoid provider rate limits

function loadSchedule() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true });
}

function loadSentLog() {
  if (!fs.existsSync(SENT_LOG)) return {};
  return JSON.parse(fs.readFileSync(SENT_LOG, 'utf8'));
}

function markSent(sendIndex) {
  const log = loadSentLog();
  log[sendIndex] = new Date().toISOString();
  fs.writeFileSync(SENT_LOG, JSON.stringify(log, null, 2));
}

function personalize(body, recipientEmail) {
  const name = recipientEmail.split('@')[0];
  return body.replace(/{{\s*name\s*}}/gi, name);
}

function withFooter(body, recipientEmail) {
  const unsubUrl = `${process.env.UNSUBSCRIBE_BASE_URL}?email=${encodeURIComponent(recipientEmail)}`;
  return `${body}

---
${process.env.FROM_NAME || 'Cityview Hospital Clinic'} · Faculty of Arts Clinic, University of Lagos
If you no longer want these emails, unsubscribe here: ${unsubUrl}`;
}

// Swap this function out for whichever provider's SDK/API you use.
async function sendBatch(recipients, subject, body) {
  const results = [];
  for (const to of recipients) {
    const personalized = withFooter(personalize(body, to), to);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: process.env.FROM_EMAIL, name: process.env.FROM_NAME },
        replyTo: { email: process.env.REPLY_TO || process.env.FROM_EMAIL },
        to: [{ email: to }],
        subject,
        textContent: personalized,
        headers: {
          // Real one-click unsubscribe header — inbox providers weigh this
          // heavily when deciding whether mail is legitimate bulk mail.
          'List-Unsubscribe': `<${process.env.UNSUBSCRIBE_BASE_URL}?email=${encodeURIComponent(to)}>`,
        },
      }),
    });
    results.push({ to, ok: res.ok, status: res.status });
    await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }
  return results;
}

async function runDueSends() {
  const schedule = loadSchedule();
  const sentLog = loadSentLog();
  const now = new Date();

  for (const row of schedule) {
    const due = new Date(row.date_iso);
    const alreadySent = sentLog[row.send_index];
    if (alreadySent) continue;
    if (due > now) continue; // not due yet

    // NOTE: recipients for this batch should come from your own list
    // storage (DB, CRM, form export) filtered to whoever this batch
    // targets — the CSV only stores the count. Wire recipientsForBatch()
    // up to your actual recipient source before running in production.
    const recipients = await recipientsForBatch(row);
    const subject = JSON.parse(row.subject);
    const body = JSON.parse(row.body);

    console.log(`Sending batch #${row.send_index} (${recipients.length} recipients)…`);
    await sendBatch(recipients, subject, body);
    markSent(row.send_index);
    console.log(`Batch #${row.send_index} done.`);
  }
}

async function recipientsForBatch(row) {
  // Placeholder — replace with your real recipient source.
  // e.g. read from a Google Sheet, a database of opted-in contacts, etc.
  throw new Error('Wire recipientsForBatch() to your actual opted-in recipient list before running.');
}

// Check every hour for sends that have come due, rather than firing
// everything at once — this is also what keeps alternate-day spacing real
// instead of just a label in a spreadsheet.
cron.schedule('0 * * * *', () => {
  runDueSends().catch(err => console.error('Send run failed:', err));
});

console.log('Relay schedule runner started. Checking hourly for due sends.');
