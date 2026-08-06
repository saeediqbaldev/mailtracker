require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");

const { initDb } = require("./db");
const authRoutes = require("./routes/auth");
const trackRoutes = require("./routes/track");
const apiRoutes = require("./routes/api");

const REQUIRED_ENV = [
  "APP_BASE_URL",
  "JWT_SECRET",
  "API_KEY",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "DATABASE_URL",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();

app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Public tracking endpoints (pixel, click, extension's "create email" call).
app.use("/", trackRoutes);

// Dashboard auth + data API.
app.use("/api/auth", authRoutes);
app.use("/api", apiRoutes);

// Dashboard frontend (static, no build step). Explicitly disable caching so
// deploys always take effect immediately — no stale login screens / old JS.
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Xeven MTracker listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
