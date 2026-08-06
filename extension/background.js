// Background service worker: does the actual network call to the tracking
// backend (content scripts can also fetch directly since host_permissions
// grants cross-origin access, but centralizing it here keeps the API key
// out of the page context and makes it easy to add retry/logging later).

// Xeven MTracker — background service worker
//
// These defaults are baked in for this deployment so the extension works
// immediately after loading it — no options page setup required. They're
// written to chrome.storage.sync on install, and getSettings() also falls
// back to them directly as a safety net.
const DEFAULT_BACKEND_URL = "https://journal.xevenpixels.com";
const DEFAULT_API_KEY = "6e5f95f52d2397901d4bb6a1adea17d3d00da98ab5de23a6edcd3e94b0147b5e";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(["backendUrl", "apiKey"]);
  const updates = {};
  if (!existing.backendUrl) updates.backendUrl = DEFAULT_BACKEND_URL;
  if (!existing.apiKey) updates.apiKey = DEFAULT_API_KEY;
  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
});

async function getSettings() {
  const { backendUrl, apiKey } = await chrome.storage.sync.get(["backendUrl", "apiKey"]);
  return {
    backendUrl: (backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, ""),
    apiKey: apiKey || DEFAULT_API_KEY,
  };
}

async function createTrackedEmail({ subject, recipients, sender, provider }) {
  const { backendUrl, apiKey } = await getSettings();

  if (!backendUrl || !apiKey) {
    throw new Error("Set the backend URL and API key in the extension options first.");
  }

  const res = await fetch(`${backendUrl}/api/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ subject, recipients, sender, provider: provider || "zoho" }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backend rejected the request (${res.status}): ${text}`);
  }

  return res.json();
}

async function fetchStats() {
  const { backendUrl, apiKey } = await getSettings();
  if (!backendUrl || !apiKey) throw new Error("Not configured");

  const res = await fetch(`${backendUrl}/api/stats`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Stats request failed (${res.status})`);
  return res.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CREATE_TRACKED_EMAIL") {
    createTrackedEmail(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "FETCH_STATS") {
    fetchStats()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
