const DEFAULT_BACKEND_URL = "https://journal.xevenpixels.com";

async function init() {
  const { backendUrl } = await chrome.storage.sync.get(["backendUrl"]);
  const resolvedUrl = backendUrl || DEFAULT_BACKEND_URL;
  const msg = document.getElementById("msg");
  const link = document.getElementById("dashboard-link");

  link.href = resolvedUrl;

  chrome.runtime.sendMessage({ type: "FETCH_STATS" }, (response) => {
    if (!response || !response.ok) {
      msg.textContent = (response && response.error) || "Could not load stats.";
      return;
    }
    const s = response.data;
    document.getElementById("p-sent").textContent = s.total_sent;
    document.getElementById("p-opened").textContent = s.total_opened;
    document.getElementById("p-rate").textContent =
      s.total_sent > 0 ? `${Math.round(s.open_rate * 100)}%` : "—";
  });
}

init();
