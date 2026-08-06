const nodemailer = require("nodemailer");
const { pool } = require("./db");

// Settings-page values win when present; .env values are the fallback
// (so a fresh deploy with only .env filled in still works before anyone
// touches the Settings UI).
async function resolveSmtpConfig() {
  const { rows } = await pool.query(
    `SELECT notify_email_enabled, notify_email_to,
            smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from
     FROM settings WHERE id = 1`
  );
  const s = rows[0] || {};

  return {
    enabled: !!s.notify_email_enabled,
    to: s.notify_email_to || null,
    host: s.smtp_host || process.env.SMTP_HOST || null,
    port: s.smtp_port || parseInt(process.env.SMTP_PORT, 10) || 465,
    user: s.smtp_user || process.env.SMTP_USER || null,
    pass: s.smtp_pass || process.env.SMTP_PASS || null,
    from: s.smtp_from || process.env.SMTP_FROM || s.smtp_user || process.env.SMTP_USER || null,
  };
}

function buildTransporter(cfg) {
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // Zoho: 465 = SSL, 587 = STARTTLS
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

// Sends a notification email if the feature is turned on in Settings AND
// SMTP is configured (from Settings or .env). Never throws — failures are
// logged, not propagated, so a bad SMTP config can never break pixel/click
// tracking.
async function sendEmailNotification({ subject, text, html }) {
  try {
    const cfg = await resolveSmtpConfig();
    if (!cfg.enabled || !cfg.to) return { ok: false, reason: "Email notifications are off" };

    const transport = buildTransporter(cfg);
    if (!transport) {
      console.warn("[notify] Email notification skipped: SMTP not fully configured.");
      return { ok: false, reason: "SMTP not configured" };
    }

    await transport.sendMail({ from: cfg.from, to: cfg.to, subject, text, html });
    return { ok: true };
  } catch (err) {
    console.error("[notify] Failed to send email notification:", err.message);
    return { ok: false, reason: err.message };
  }
}

// Used by the Settings page's "Send test email" button. Unlike
// sendEmailNotification, this ignores the enabled/disabled toggle (a test
// send should work even while you're still setting things up) but still
// requires a destination + working SMTP config, and surfaces the real
// error back to the caller instead of just logging it.
async function sendTestEmail() {
  const cfg = await resolveSmtpConfig();
  if (!cfg.to) throw new Error('Set "Send notifications to" first, then save, then test.');

  const transport = buildTransporter(cfg);
  if (!transport) {
    throw new Error(
      "SMTP host/user/password aren't fully set (in Settings or .env) — fill those in first."
    );
  }

  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: "Xeven MTracker — test notification",
    text: "If you're reading this, email notifications are working correctly.",
  });
}

module.exports = { sendEmailNotification, sendTestEmail, resolveSmtpConfig };
