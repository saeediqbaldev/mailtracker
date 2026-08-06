const DEFAULT_BACKEND_URL = "https://journal.xevenpixels.com";
const DEFAULT_API_KEY = "6e5f95f52d2397901d4bb6a1adea17d3d00da98ab5de23a6edcd3e94b0147b5e";

const backendUrlInput = document.getElementById("backend-url");
const apiKeyInput = document.getElementById("api-key");
const statusEl = document.getElementById("status");

async function load() {
  const { backendUrl, apiKey } = await chrome.storage.sync.get(["backendUrl", "apiKey"]);
  backendUrlInput.value = backendUrl || DEFAULT_BACKEND_URL;
  apiKeyInput.value = apiKey || DEFAULT_API_KEY;
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const backendUrl = backendUrlInput.value.trim().replace(/\/$/, "");
  const apiKey = apiKeyInput.value.trim();

  await chrome.storage.sync.set({ backendUrl, apiKey });
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

load();
