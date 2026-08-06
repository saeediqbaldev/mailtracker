const jwt = require("jsonwebtoken");

function requireApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

function verifySession(req) {
  const token = req.cookies && req.cookies.session;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireSession(req, res, next) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  req.admin = session;
  next();
}

// Accepts either a dashboard session cookie OR an API key header.
// Used on read endpoints the extension popup also needs (e.g. stats).
function requireSessionOrApiKey(req, res, next) {
  const session = verifySession(req);
  if (session) {
    req.admin = session;
    return next();
  }
  const key = req.header("x-api-key");
  if (key && key === process.env.API_KEY) {
    return next();
  }
  return res.status(401).json({ error: "Not authorized" });
}

module.exports = { requireApiKey, requireSession, requireSessionOrApiKey };
