const express = require("express");
const { pool } = require("../db");
const { requireSessionOrApiKey } = require("../middleware/auth");
const { sendTestEmail } = require("../notify");

const router = express.Router();

router.use(requireSessionOrApiKey);

// Every mail client the dashboard/extension knows about. Adding a new one
// (see /extension/content-script-<name>.js) means adding its string here —
// every provider-scoped query below reads from this single list.
const VALID_PROVIDERS = ["zoho", "gmail", "hostinger"];
const isValidProvider = (p) => VALID_PROVIDERS.includes(p);

// GET /api/stats?provider=zoho|gmail|hostinger
router.get("/stats", async (req, res) => {
  const { provider } = req.query;
  const clause = isValidProvider(provider) ? `WHERE provider = $1` : "";
  const values = clause ? [provider] : [];

  try {
    const totals = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_sent,
        COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::int AS total_opened,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS total_unopened,
        COUNT(*) FILTER (WHERE status = 'clicked')::int AS total_clicked,
        COALESCE(SUM(open_count), 0)::int AS total_open_events
      FROM emails
      ${clause}
    `,
      values
    );

    const row = totals.rows[0];
    const openRate = row.total_sent > 0 ? row.total_opened / row.total_sent : 0;

    res.json({ ...row, open_rate: openRate });
  } catch (err) {
    console.error("Failed to load stats:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// GET /api/emails?status=&recipient=&search=&from=&to=&provider=&limit=&offset=
router.get("/emails", async (req, res) => {
  const { status, recipient, search, from, to, provider } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  const clauses = [];
  const values = [];

  if (isValidProvider(provider)) {
    values.push(provider);
    clauses.push(`provider = $${values.length}`);
  }
  if (status === "opened") {
    // "Opened" in the stats includes clicked records (a click implies it
    // was opened) — keep the list filter consistent with that.
    clauses.push(`status IN ('opened', 'clicked')`);
  } else if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  if (recipient) {
    values.push(`%${recipient}%`);
    clauses.push(`EXISTS (SELECT 1 FROM unnest(recipients) r WHERE r ILIKE $${values.length})`);
  }
  if (search) {
    values.push(`%${search}%`);
    clauses.push(`subject ILIKE $${values.length}`);
  }
  if (from) {
    values.push(from);
    clauses.push(`created_at >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    clauses.push(`created_at <= $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  values.push(limit);
  values.push(offset);

  try {
    const result = await pool.query(
      `SELECT id, subject, recipients, sender, provider, created_at, status,
              open_count, click_count, first_opened_at, last_opened_at
       FROM emails
       ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    res.json({ emails: result.rows });
  } catch (err) {
    console.error("Failed to list emails:", err);
    res.status(500).json({ error: "Failed to list emails" });
  }
});

// GET /api/emails/:id
router.get("/emails/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const emailResult = await pool.query(`SELECT * FROM emails WHERE id = $1`, [id]);
    if (emailResult.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const opens = await pool.query(
      `SELECT id, opened_at, ip, user_agent FROM opens WHERE email_id = $1 ORDER BY opened_at DESC`,
      [id]
    );
    const clicks = await pool.query(
      `SELECT id, url, clicked_at, ip, user_agent FROM clicks WHERE email_id = $1 ORDER BY clicked_at DESC`,
      [id]
    );

    res.json({
      email: emailResult.rows[0],
      opens: opens.rows,
      clicks: clicks.rows,
    });
  } catch (err) {
    console.error("Failed to load email detail:", err);
    res.status(500).json({ error: "Failed to load email detail" });
  }
});

// PATCH /api/emails/:id  { notes }
router.patch("/emails/:id", async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body || {};

  if (typeof notes !== "string") {
    return res.status(400).json({ error: "notes must be a string" });
  }

  try {
    const result = await pool.query(
      `UPDATE emails SET notes = $1 WHERE id = $2 RETURNING *`,
      [notes, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ email: result.rows[0] });
  } catch (err) {
    console.error("Failed to update email:", err);
    res.status(500).json({ error: "Failed to update email" });
  }
});

// DELETE /api/emails/:id
router.delete("/emails/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM emails WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error("Failed to delete email:", err);
    res.status(500).json({ error: "Failed to delete email" });
  }
});

// POST /api/emails/bulk-delete  { ids: [...] }
router.post("/emails/bulk-delete", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids must be a non-empty array" });
  }

  try {
    const result = await pool.query(`DELETE FROM emails WHERE id = ANY($1::uuid[]) RETURNING id`, [
      ids,
    ]);
    res.json({ ok: true, deleted: result.rows.map((r) => r.id) });
  } catch (err) {
    console.error("Failed to bulk delete emails:", err);
    res.status(500).json({ error: "Failed to bulk delete emails" });
  }
});

// ==================== Notifications ====================
// GET /api/notifications?unread=true&type=open&provider=&limit=&offset=
router.get("/notifications", async (req, res) => {
  const { unread, type, provider } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  const clauses = [];
  const values = [];

  if (isValidProvider(provider)) {
    values.push(provider);
    clauses.push(`e.provider = $${values.length}`);
  }
  if (unread === "true") clauses.push(`n.is_read = false`);
  if (type === "open" || type === "click") {
    values.push(type);
    clauses.push(`n.type = $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(limit);
  values.push(offset);

  try {
    const result = await pool.query(
      `SELECT n.id, n.email_id, n.type, n.url, n.message, n.is_read, n.created_at,
              e.subject, e.recipients, e.provider
       FROM notifications n
       JOIN emails e ON e.id = n.email_id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    console.error("Failed to list notifications:", err);
    res.status(500).json({ error: "Failed to list notifications" });
  }
});

// GET /api/notifications/unread-count?provider=zoho|gmail|hostinger
router.get("/notifications/unread-count", async (req, res) => {
  const { provider } = req.query;
  try {
    let result;
    if (isValidProvider(provider)) {
      result = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM notifications n JOIN emails e ON e.id = n.email_id
         WHERE n.is_read = false AND e.provider = $1`,
        [provider]
      );
    } else {
      result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM notifications WHERE is_read = false`
      );
    }
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error("Failed to count unread notifications:", err);
    res.status(500).json({ error: "Failed to count unread notifications" });
  }
});

// PATCH /api/notifications/:id  { is_read }
router.patch("/notifications/:id", async (req, res) => {
  const { id } = req.params;
  const { is_read } = req.body || {};
  if (typeof is_read !== "boolean") {
    return res.status(400).json({ error: "is_read must be a boolean" });
  }
  try {
    const result = await pool.query(
      `UPDATE notifications SET is_read = $1 WHERE id = $2 RETURNING *`,
      [is_read, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ notification: result.rows[0] });
  } catch (err) {
    console.error("Failed to update notification:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// POST /api/notifications/mark-all-read
router.post("/notifications/mark-all-read", async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read = true WHERE is_read = false`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to mark all notifications read:", err);
    res.status(500).json({ error: "Failed to mark all notifications read" });
  }
});

// DELETE /api/notifications/:id
router.delete("/notifications/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM notifications WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, id });
  } catch (err) {
    console.error("Failed to delete notification:", err);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// POST /api/notifications/bulk-delete  { ids: [...] }
router.post("/notifications/bulk-delete", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids must be a non-empty array" });
  }
  try {
    const result = await pool.query(
      `DELETE FROM notifications WHERE id = ANY($1::bigint[]) RETURNING id`,
      [ids]
    );
    res.json({ ok: true, deleted: result.rows.map((r) => r.id) });
  } catch (err) {
    console.error("Failed to bulk delete notifications:", err);
    res.status(500).json({ error: "Failed to bulk delete notifications" });
  }
});

// ==================== Settings ====================
// GET /api/settings
// Never returns the raw smtp_pass — only whether one is set — so it can't
// leak back to the browser on every page load.
router.get("/settings", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM settings WHERE id = 1`);
    const row = result.rows[0] || {};
    const { smtp_pass, ...rest } = row;
    res.json({ settings: { ...rest, smtp_pass_set: !!smtp_pass } });
  } catch (err) {
    console.error("Failed to load settings:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// PUT /api/settings
// { refresh_interval_seconds, notify_email_enabled, notify_email_to,
//   smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from }
// smtp_pass is optional on every call — omit it (or send "") to leave the
// currently-saved password untouched, e.g. when just flipping the enabled
// checkbox without retyping the password.
router.put("/settings", async (req, res) => {
  const {
    refresh_interval_seconds,
    notify_email_enabled,
    notify_email_to,
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass,
    smtp_from,
  } = req.body || {};

  if (
    refresh_interval_seconds !== undefined &&
    (!Number.isInteger(refresh_interval_seconds) ||
      refresh_interval_seconds < 0 ||
      refresh_interval_seconds > 3600)
  ) {
    return res.status(400).json({ error: "refresh_interval_seconds must be 0-3600" });
  }
  if (notify_email_enabled !== undefined && typeof notify_email_enabled !== "boolean") {
    return res.status(400).json({ error: "notify_email_enabled must be a boolean" });
  }
  if (notify_email_to !== undefined && typeof notify_email_to !== "string") {
    return res.status(400).json({ error: "notify_email_to must be a string" });
  }
  if (
    smtp_port !== undefined &&
    smtp_port !== null &&
    (!Number.isInteger(smtp_port) || smtp_port < 1 || smtp_port > 65535)
  ) {
    return res.status(400).json({ error: "smtp_port must be a valid port number" });
  }

  try {
    const result = await pool.query(
      `UPDATE settings SET
         refresh_interval_seconds = COALESCE($1, refresh_interval_seconds),
         notify_email_enabled = COALESCE($2, notify_email_enabled),
         notify_email_to = COALESCE($3, notify_email_to),
         smtp_host = COALESCE($4, smtp_host),
         smtp_port = COALESCE($5, smtp_port),
         smtp_user = COALESCE($6, smtp_user),
         smtp_pass = CASE WHEN $7 = '' OR $7 IS NULL THEN smtp_pass ELSE $7 END,
         smtp_from = COALESCE($8, smtp_from)
       WHERE id = 1
       RETURNING *`,
      [
        refresh_interval_seconds ?? null,
        notify_email_enabled ?? null,
        notify_email_to ?? null,
        smtp_host ?? null,
        smtp_port ?? null,
        smtp_user ?? null,
        smtp_pass ?? null,
        smtp_from ?? null,
      ]
    );
    const { smtp_pass: _hidden, ...rest } = result.rows[0];
    res.json({ settings: { ...rest, smtp_pass_set: !!_hidden } });
  } catch (err) {
    console.error("Failed to update settings:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// POST /api/settings/test-email
// Sends a one-off test email using whatever SMTP config is currently saved
// (Settings takes priority, .env is the fallback) — ignores the on/off
// toggle so it's useful while you're still setting things up.
router.post("/settings/test-email", async (req, res) => {
  try {
    await sendTestEmail();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== Analytics ====================
const RANGE_TO_SQL = {
  "1d": { interval: "1 day", bucket: "hour" },
  "7d": { interval: "7 days", bucket: "day" },
  "30d": { interval: "30 days", bucket: "day" },
  "90d": { interval: "90 days", bucket: "day" },
  "1y": { interval: "1 year", bucket: "month" },
};

// GET /api/analytics?range=1d|7d|30d|90d|1y&provider=zoho|gmail|hostinger
router.get("/analytics", async (req, res) => {
  const range = RANGE_TO_SQL[req.query.range] ? req.query.range : "7d";
  const { interval, bucket } = RANGE_TO_SQL[range];
  const provider = isValidProvider(req.query.provider) ? req.query.provider : null;
  // Every subquery below joins back to emails so a provider filter can
  // apply consistently to opens/clicks (which don't carry provider
  // themselves) as well as to emails directly. $1 is always "since"; the
  // provider param position varies per query below, so each query builds
  // its own params array rather than sharing one.
  const providerClause = provider ? `AND e.provider = $2` : "";
  // The timeseries query has an extra $2 (the bucket unit) ahead of the
  // provider param, so its provider placeholder is $3, not $2 — needs its
  // own clause rather than reusing providerClause.
  const providerClauseTs = provider ? `AND e.provider = $3` : "";

  try {
    const sinceResult = await pool.query(`SELECT now() - $1::interval AS since`, [interval]);
    const since = sinceResult.rows[0].since;

    const sentClause = provider ? `WHERE created_at >= $1 AND provider = $2` : `WHERE created_at >= $1`;
    const sentParams = provider ? [since, provider] : [since];

    const summary = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM emails ${sentClause}) AS sent,
        (SELECT COUNT(*)::int FROM opens o JOIN emails e ON e.id = o.email_id
           WHERE o.opened_at >= $1 ${providerClause}) AS opens,
        (SELECT COUNT(*)::int FROM clicks c JOIN emails e ON e.id = c.email_id
           WHERE c.clicked_at >= $1 ${providerClause}) AS clicks,
        (SELECT COUNT(DISTINCT o.email_id)::int FROM opens o JOIN emails e ON e.id = o.email_id
           WHERE o.opened_at >= $1 ${providerClause}) AS unique_opened`,
      sentParams
    );
    const s = summary.rows[0];
    const openRate = s.sent > 0 ? s.unique_opened / s.sent : 0;

    const timeseries = await pool.query(
      `SELECT
         date_trunc($2, ts) AS bucket,
         COUNT(*) FILTER (WHERE kind = 'open')::int AS opens,
         COUNT(*) FILTER (WHERE kind = 'click')::int AS clicks
       FROM (
         SELECT o.opened_at AS ts, 'open' AS kind FROM opens o JOIN emails e ON e.id = o.email_id
           WHERE o.opened_at >= $1 ${providerClauseTs}
         UNION ALL
         SELECT c.clicked_at AS ts, 'click' AS kind FROM clicks c JOIN emails e ON e.id = c.email_id
           WHERE c.clicked_at >= $1 ${providerClauseTs}
       ) ev
       GROUP BY 1
       ORDER BY 1`,
      provider ? [since, bucket, provider] : [since, bucket]
    );

    const heatmap = await pool.query(
      `SELECT
         EXTRACT(DOW FROM ts)::int AS day,
         EXTRACT(HOUR FROM ts)::int AS hour,
         COUNT(*)::int AS count
       FROM (
         SELECT o.opened_at AS ts FROM opens o JOIN emails e ON e.id = o.email_id
           WHERE o.opened_at >= $1 ${providerClause}
         UNION ALL
         SELECT c.clicked_at AS ts FROM clicks c JOIN emails e ON e.id = c.email_id
           WHERE c.clicked_at >= $1 ${providerClause}
       ) ev
       GROUP BY 1, 2`,
      provider ? [since, provider] : [since]
    );

    res.json({
      range,
      provider: provider || "all",
      summary: { ...s, open_rate: openRate },
      timeseries: timeseries.rows,
      heatmap: heatmap.rows,
    });
  } catch (err) {
    console.error("Failed to load analytics:", err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

// ==================== History (flat open/click event log) ====================
// GET /api/history?provider=zoho|gmail|hostinger&type=open|click&search=&from=&to=&limit=&offset=
router.get("/history", async (req, res) => {
  const { provider, type, search, from, to } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  const clauses = [];
  const values = [];

  if (isValidProvider(provider)) {
    values.push(provider);
    clauses.push(`e.provider = $${values.length}`);
  }
  if (type === "open" || type === "click") {
    values.push(type);
    clauses.push(`ev.type = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    clauses.push(`e.subject ILIKE $${values.length}`);
  }
  if (from) {
    values.push(from);
    clauses.push(`ev.ts >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    clauses.push(`ev.ts <= $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(limit);
  values.push(offset);

  try {
    const result = await pool.query(
      `SELECT ev.type, ev.ts, ev.ip, ev.user_agent, ev.url,
              e.id AS email_id, e.subject, e.recipients, e.provider
       FROM (
         SELECT 'open' AS type, id, email_id, opened_at AS ts, ip, user_agent, NULL::text AS url FROM opens
         UNION ALL
         SELECT 'click' AS type, id, email_id, clicked_at AS ts, ip, user_agent, url FROM clicks
       ) ev
       JOIN emails e ON e.id = ev.email_id
       ${where}
       ORDER BY ev.ts DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({ events: result.rows });
  } catch (err) {
    console.error("Failed to load history:", err);
    res.status(500).json({ error: "Failed to load history" });
  }
});

module.exports = router;
