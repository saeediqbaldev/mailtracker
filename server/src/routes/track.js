const express = require("express");
const { pool } = require("../db");
const { requireApiKey } = require("../middleware/auth");
const { sendEmailNotification } = require("../notify");
const { isLikelyBotOrScanner } = require("../botFilter");

const router = express.Router();

// 1x1 transparent PNG, served for every pixel request regardless of outcome.
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function clientIp(req) {
  const fwd = req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress;
}

// ---- Called by the browser extension right before/at send time ----
router.post("/api/emails", requireApiKey, async (req, res) => {
  const { subject, recipients, sender } = req.body || {};
  const VALID_PROVIDERS = ["zoho", "gmail", "hostinger"];
  // Older extension builds (pre-Gmail/Hostinger support) never send this
  // field — defaulting to 'zoho' keeps them working exactly as before.
  const provider = VALID_PROVIDERS.includes(req.body && req.body.provider)
    ? req.body.provider
    : "zoho";

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "recipients must be a non-empty array" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO emails (subject, recipients, sender, sender_ip, provider)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [subject || "", recipients, sender || null, clientIp(req), provider]
    );

    const id = result.rows[0].id;
    const base = process.env.APP_BASE_URL.replace(/\/$/, "");

    res.json({
      id,
      pixelUrl: `${base}/t/${id}/pixel.png`,
      clickBaseUrl: `${base}/t/${id}/click`,
      createdAt: result.rows[0].created_at,
    });
  } catch (err) {
    console.error("Failed to create tracked email:", err);
    res.status(500).json({ error: "Failed to create tracked email" });
  }
});

// How long after sending to ignore pixel hits — covers the sender's own mail
// client auto-loading images when it renders the Sent-folder copy, and any
// server-side link/image prefetching that fires right at send time. Real
// recipients essentially never open mail within this window.
const OPEN_GRACE_MS = (parseInt(process.env.OPEN_GRACE_SECONDS, 10) || 8) * 1000;

// ---- Tracking pixel ----
router.get("/t/:id/pixel.png", async (req, res) => {
  res.set({
    "Content-Type": "image/png",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  const { id } = req.params;
  const uuidLike = /^[0-9a-f-]{36}$/i.test(id);

  if (uuidLike) {
    try {
      const emailRes = await pool.query(
        `SELECT sender_ip, created_at, first_opened_at, subject, recipients
         FROM emails WHERE id = $1`,
        [id]
      );

      if (emailRes.rows.length > 0) {
        const { sender_ip, created_at, first_opened_at, subject, recipients } = emailRes.rows[0];
        const requestIp = clientIp(req);
        const userAgent = req.header("user-agent") || "";

        const isSelf = sender_ip && requestIp && sender_ip === requestIp;
        const withinGrace = Date.now() - new Date(created_at).getTime() < OPEN_GRACE_MS;
        const isBot = isLikelyBotOrScanner(userAgent);
        const isFirstOpen = !first_opened_at;

        if (!isSelf && !withinGrace && !isBot) {
          await pool.query(
            `INSERT INTO opens (email_id, ip, user_agent) VALUES ($1, $2, $3)`,
            [id, requestIp, userAgent || null]
          );

          await pool.query(
            `UPDATE emails
             SET status = 'opened',
                 open_count = open_count + 1,
                 first_opened_at = COALESCE(first_opened_at, now()),
                 last_opened_at = now()
             WHERE id = $1`,
            [id]
          );

          // Only notify on the FIRST genuine open of an email — repeat
          // opens (recipient re-reading it) still update counters above,
          // but don't spam the Notifications page or inbox again.
          if (isFirstOpen) {
            const who = (recipients || []).join(", ") || "unknown recipient";
            const subj = subject || "(no subject)";
            const message = `"${subj}" was opened by ${who}`;

            await pool.query(
              `INSERT INTO notifications (email_id, type, message) VALUES ($1, 'open', $2)`,
              [id, message]
            );

            sendEmailNotification({
              subject: `Opened: ${subj}`,
              text: `${message}\n\nOpened at: ${new Date().toISOString()}`,
            }).catch((err) => console.error("[notify] open email failed:", err.message));
          }
        } else if (isBot) {
          console.log(`[bot-filter] Ignored pixel hit from suspected scanner/proxy UA: "${userAgent}"`);
        }
      }
    } catch (err) {
      // Swallow errors (e.g. unknown/deleted id) — still return the pixel.
      console.error("Pixel logging failed:", err.message);
    }
  }

  res.status(200).end(TRANSPARENT_PNG);
});

// ---- Link click redirect ----
router.get("/t/:id/click", async (req, res) => {
  const { id } = req.params;
  const target = req.query.url;

  if (!target) return res.status(400).send("Missing url");

  let decoded;
  try {
    decoded = decodeURIComponent(target);
    // Only allow redirecting to http(s) URLs.
    const parsed = new URL(decoded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
  } catch (e) {
    return res.status(400).send("Invalid url");
  }

  const uuidLike = /^[0-9a-f-]{36}$/i.test(id);
  if (uuidLike) {
    const userAgent = req.header("user-agent") || "";
    const isBot = isLikelyBotOrScanner(userAgent);

    if (isBot) {
      console.log(`[bot-filter] Ignored click hit from suspected scanner/preview-bot UA: "${userAgent}"`);
      // Still redirect — a security scanner following the link needs a
      // valid response too, we just don't want it counted or notified.
      return res.redirect(302, decoded);
    }

    try {
      await pool.query(
        `INSERT INTO clicks (email_id, url, ip, user_agent) VALUES ($1, $2, $3, $4)`,
        [id, decoded, clientIp(req), userAgent || null]
      );
      await pool.query(
        `UPDATE emails
         SET status = 'clicked', click_count = click_count + 1
         WHERE id = $1`,
        [id]
      );

      // Every click gets a notification (unlike opens, which only notify
      // on the first one) — a recipient clicking a link is a strong,
      // always-relevant signal worth surfacing every time.
      const emailRes = await pool.query(
        `SELECT subject, recipients FROM emails WHERE id = $1`,
        [id]
      );
      if (emailRes.rows.length > 0) {
        const { subject, recipients } = emailRes.rows[0];
        const who = (recipients || []).join(", ") || "unknown recipient";
        const subj = subject || "(no subject)";
        const message = `${who} clicked a link in "${subj}"`;

        await pool.query(
          `INSERT INTO notifications (email_id, type, url, message) VALUES ($1, 'click', $2, $3)`,
          [id, decoded, message]
        );

        sendEmailNotification({
          subject: `Link clicked: ${subj}`,
          text: `${message}\n\nURL: ${decoded}\nClicked at: ${new Date().toISOString()}`,
        }).catch((err) => console.error("[notify] click email failed:", err.message));
      }
    } catch (err) {
      console.error("Click logging failed:", err.message);
    }
  }

  res.redirect(302, decoded);
});

module.exports = router;
