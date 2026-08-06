const BUILD_TAG = "xeven-mtracker-2026-08-04-r5-gmail";
console.log("[Xeven MTracker]", BUILD_TAG);
const buildTagEl = document.getElementById("build-tag");
if (buildTagEl) buildTagEl.textContent = BUILD_TAG;

const loginScreen = document.getElementById("login-screen");
const dashboardScreen = document.getElementById("dashboard-screen");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");

const ledgerBody = document.getElementById("ledger-body");
const detailPanel = document.getElementById("detail-panel");

let currentDetailId = null;
let pollTimer = null;
let notifBadgeTimer = null;
const selectedIds = new Set();

let currentView = "tracking"; // kept for the polling loop's benefit
let currentProvider = "zoho"; // 'zoho' | 'gmail' — which tab's data is showing
let currentSubView = "tracking"; // 'tracking' | 'history' | 'reports' | 'alerts'
let onSettingsTab = false;
let refreshIntervalSeconds = 15; // overwritten by /api/settings on load
let currentRange = "7d";
let analyticsChart = null;
const notifSelectedIds = new Set();

// Runs an init block in isolation — if one part of the page fails to wire
// up (a missing element, a typo, whatever), it's logged clearly and every
// OTHER part of the page still works. Nothing here should ever be able to
// take down the rest of the script.
function safeRun(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[Xeven MTracker] Failed to initialize "${label}":`, err);
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function statusStamp(status) {
  const map = {
    sent: ["SENT", "stamp-sent"],
    opened: ["OPENED", "stamp-opened"],
    clicked: ["CLICKED", "stamp-clicked"],
  };
  const [label, cls] = map[status] || map.sent;
  return `<span class="stamp ${cls}">${label}</span>`;
}

// ---- Auth flow ----

function showLogin() {
  if (loginScreen) loginScreen.hidden = false;
  if (dashboardScreen) dashboardScreen.hidden = true;
  stopPolling();
}

async function showDashboard(email) {
  if (loginScreen) loginScreen.hidden = true;
  if (dashboardScreen) dashboardScreen.hidden = false;
  const signedInAs = document.getElementById("signed-in-as");
  if (signedInAs) signedInAs.textContent = email ? `Signed in as ${email}` : "";

  await loadSettings();
  loadStats();
  loadEmails();
  loadBothProviderBadges();
  startPolling();
}

function startPolling() {
  stopPolling();
  if (refreshIntervalSeconds > 0) {
    pollTimer = setInterval(() => {
      if (onSettingsTab) {
        loadBothProviderBadges();
        return;
      }
      loadStats();
      if (currentSubView === "tracking" && !currentDetailId) loadEmails();
      if (currentSubView === "reports") loadAnalytics(currentRange);
      if (currentSubView === "history") loadHistory();
      if (currentSubView === "alerts") loadNotifications();
      loadBothProviderBadges();
    }, refreshIntervalSeconds * 1000);
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function checkSession() {
  try {
    const me = await api("/api/auth/me");
    showDashboard(me.email);
  } catch (e) {
    showLogin();
  }
}

// ---- Stats ----

async function loadStats() {
  try {
    const s = await api(`/api/stats?provider=${currentProvider}`);
    document.getElementById("stat-sent").textContent = s.total_sent;
    document.getElementById("stat-opened").textContent = s.total_opened;
    document.getElementById("stat-unopened").textContent = s.total_unopened;
    document.getElementById("stat-clicked").textContent = s.total_clicked;
    document.getElementById("stat-rate").textContent =
      s.total_sent > 0 ? `${Math.round(s.open_rate * 100)}%` : "—";
  } catch (e) {
    console.error("[Xeven MTracker] Failed to load stats:", e);
  }
}

// ---- Email list ----

function buildQuery() {
  const params = new URLSearchParams();
  const status = document.getElementById("filter-status")?.value;
  const recipient = document.getElementById("filter-recipient")?.value;
  const search = document.getElementById("filter-search")?.value;
  const from = document.getElementById("filter-from")?.value;
  const to = document.getElementById("filter-to")?.value;

  params.set("provider", currentProvider);
  if (status) params.set("status", status);
  if (recipient) params.set("recipient", recipient);
  if (search) params.set("search", search);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  return params.toString();
}

async function loadEmails() {
  if (!ledgerBody) return;
  ledgerBody.innerHTML = `<tr><td colspan="8" class="empty-row">Loading…</td></tr>`;
  try {
    const query = buildQuery();
    const { emails } = await api(`/api/emails${query ? "?" + query : ""}`);

    if (emails.length === 0) {
      const label = providerLabel(currentProvider);
      ledgerBody.innerHTML = `<tr><td colspan="8" class="empty-row">No tracked emails yet. Send one from ${label} with tracking turned on.</td></tr>`;
      selectedIds.clear();
      updateBulkBar();
      return;
    }

    ledgerBody.innerHTML = emails
      .map(
        (e) => `
      <tr data-id="${e.id}">
        <td><input type="checkbox" class="row-checkbox" data-id="${e.id}" ${selectedIds.has(e.id) ? "checked" : ""} /></td>
        <td>${statusStamp(e.status)}</td>
        <td class="subject-cell">${escapeHtml(e.subject || "(no subject)")}</td>
        <td class="recipients-cell">${escapeHtml(e.recipients.join(", "))}</td>
        <td class="mono">${fmtDate(e.created_at)}</td>
        <td class="mono">${e.open_count}</td>
        <td class="mono">${e.click_count}</td>
        <td><button class="row-delete-btn" data-id="${e.id}" title="Delete"><svg class="icon"><use href="#icon-x"/></svg></button></td>
      </tr>`
      )
      .join("");

    document.querySelectorAll("#ledger-body tr[data-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".row-checkbox") || e.target.closest(".row-delete-btn")) return;
        openDetail(row.dataset.id);
      });
    });

    document.querySelectorAll(".row-checkbox").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateBulkBar();
      });
    });

    document.querySelectorAll(".row-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = e.target.dataset.id;
        if (!confirm("Delete this tracked email? This cannot be undone.")) return;
        await deleteEmails([id]);
      });
    });

    const selectAll = document.getElementById("select-all");
    if (selectAll) selectAll.checked = false;
  } catch (err) {
    ledgerBody.innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
  }
}

function updateBulkBar() {
  const bulkActionsRow = document.getElementById("bulk-actions-row");
  const bulkSelectedCount = document.getElementById("bulk-selected-count");
  const count = selectedIds.size;
  if (bulkActionsRow) bulkActionsRow.hidden = count === 0;
  if (bulkSelectedCount) bulkSelectedCount.textContent = `${count} selected`;
}

async function deleteEmails(ids) {
  try {
    if (ids.length === 1) {
      await api(`/api/emails/${ids[0]}`, { method: "DELETE" });
    } else {
      await api(`/api/emails/bulk-delete`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
    }
    ids.forEach((id) => selectedIds.delete(id));
    if (currentDetailId && ids.includes(currentDetailId)) {
      if (detailPanel) detailPanel.hidden = true;
      currentDetailId = null;
    }
    updateBulkBar();
    loadStats();
    loadEmails();
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

function filterByStatus(status) {
  const statusEl = document.getElementById("filter-status");
  if (statusEl) statusEl.value = status;
  ["filter-recipient", "filter-search", "filter-from", "filter-to"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  loadEmails();
}

// ---- Detail panel ----

async function openDetail(id) {
  try {
    const { email, opens, clicks } = await api(`/api/emails/${id}`);

    currentDetailId = id;
    document.getElementById("detail-subject").textContent = email.subject || "(no subject)";
    document.getElementById("detail-recipients").textContent = `To: ${email.recipients.join(", ")}`;
    document.getElementById("detail-sent").textContent = `Sent ${fmtDate(email.created_at)}`;
    document.getElementById("detail-notes").value = email.notes || "";

    const opensList = document.getElementById("detail-opens");
    opensList.innerHTML = opens.length
      ? opens.map((o) => `<li>${fmtDate(o.opened_at)} — ${escapeHtml(o.ip || "unknown IP")}</li>`).join("")
      : `<li class="history-empty">Not opened yet.</li>`;

    const clicksList = document.getElementById("detail-clicks");
    clicksList.innerHTML = clicks.length
      ? clicks.map((c) => `<li>${fmtDate(c.clicked_at)} — ${escapeHtml(c.url)}</li>`).join("")
      : `<li class="history-empty">No links clicked yet.</li>`;

    detailPanel.hidden = false;
  } catch (err) {
    console.error("[Xeven MTracker] Failed to load email detail:", err);
  }
}

// ---- View switching: two levels — provider tab (Zoho Mail / Gmail /
// Settings) and, within a provider, the sub-tab (Tracking / History /
// Reports / Alerts). Settings sits outside the provider split since it's
// account-wide (SMTP creds, refresh interval), not per-mailbox.

function showProviderTab(provider) {
  currentProvider = provider;
  onSettingsTab = false;

  document.querySelectorAll("#provider-tabs .tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.provider === provider);
  });
  document.getElementById("subtabs-row").hidden = false;
  document.getElementById("view-settings").hidden = true;

  showSubView(currentSubView);
}

function showSettingsTab() {
  onSettingsTab = true;
  document.querySelectorAll("#provider-tabs .tab-btn").forEach((btn) => {
    btn.classList.remove("active");
  });
  document.getElementById("subtabs-row").hidden = true;
  document.querySelectorAll(".view").forEach((el) => (el.hidden = true));
  document.getElementById("view-settings").hidden = false;
  loadSettingsForm();
}

function showSubView(subview) {
  currentSubView = subview;
  currentView = subview;

  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = el.id !== `view-${subview}`;
  });
  document.getElementById("view-settings").hidden = true;
  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subview === subview);
  });

  if (subview === "tracking") {
    loadStats();
    loadEmails();
  }
  if (subview === "history") loadHistory();
  if (subview === "reports") loadAnalytics(currentRange);
  if (subview === "alerts") loadNotifications();
}

// ---- Settings ----

async function loadSettings() {
  try {
    const { settings } = await api("/api/settings");
    if (settings) {
      refreshIntervalSeconds = settings.refresh_interval_seconds ?? 15;
    }
  } catch (e) {
    console.error("[Xeven MTracker] Failed to load settings:", e);
  }
}

async function loadSettingsForm() {
  try {
    const { settings } = await api("/api/settings");
    document.getElementById("setting-refresh-interval").value = String(
      settings.refresh_interval_seconds ?? 15
    );
    document.getElementById("setting-email-enabled").checked = !!settings.notify_email_enabled;
    document.getElementById("setting-email-to").value = settings.notify_email_to || "";
    document.getElementById("setting-smtp-host").value = settings.smtp_host || "";
    document.getElementById("setting-smtp-port").value = settings.smtp_port || "";
    document.getElementById("setting-smtp-user").value = settings.smtp_user || "";
    document.getElementById("setting-smtp-from").value = settings.smtp_from || "";

    const passField = document.getElementById("setting-smtp-pass");
    passField.value = "";
    passField.placeholder = settings.smtp_pass_set
      ? "•••••••• (already set — leave blank to keep)"
      : "Not set yet";
  } catch (err) {
    console.error("[Xeven MTracker] Failed to load settings form:", err);
  }
}

async function saveSettings() {
  const refresh_interval_seconds = parseInt(
    document.getElementById("setting-refresh-interval").value,
    10
  );
  const notify_email_enabled = document.getElementById("setting-email-enabled").checked;
  const notify_email_to = document.getElementById("setting-email-to").value.trim();
  const smtp_host = document.getElementById("setting-smtp-host").value.trim();
  const smtp_port_raw = document.getElementById("setting-smtp-port").value.trim();
  const smtp_port = smtp_port_raw ? parseInt(smtp_port_raw, 10) : null;
  const smtp_user = document.getElementById("setting-smtp-user").value.trim();
  const smtp_pass = document.getElementById("setting-smtp-pass").value; // "" = leave unchanged
  const smtp_from = document.getElementById("setting-smtp-from").value.trim();

  try {
    const { settings } = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        refresh_interval_seconds,
        notify_email_enabled,
        notify_email_to,
        smtp_host,
        smtp_port,
        smtp_user,
        smtp_pass,
        smtp_from,
      }),
    });
    refreshIntervalSeconds = settings.refresh_interval_seconds;
    startPolling();
    loadSettingsForm();

    const msg = document.getElementById("settings-saved-msg");
    if (msg) {
      msg.hidden = false;
      setTimeout(() => (msg.hidden = true), 2500);
    }
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
  }
}

async function sendTestEmail() {
  const msg = document.getElementById("settings-test-msg");
  if (msg) {
    msg.hidden = false;
    msg.textContent = "Sending…";
    msg.style.color = "";
  }
  try {
    await api("/api/settings/test-email", { method: "POST" });
    if (msg) msg.textContent = "Test email sent ✓";
  } catch (err) {
    if (msg) {
      msg.textContent = `Failed: ${err.message}`;
      msg.style.color = "var(--stamp-red)";
    }
  }
}

// ---- Analytics ----

const RANGE_LABELS = { "1d": "1D", "7d": "7D", "30d": "30D", "90d": "90D", "1y": "1Y" };
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtBucketLabel(iso, range) {
  const d = new Date(iso);
  if (range === "1d") return d.toLocaleTimeString(undefined, { hour: "2-digit" });
  if (range === "1y") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function loadAnalytics(range) {
  currentRange = range;
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === range);
  });

  try {
    const data = await api(`/api/analytics?range=${range}&provider=${currentProvider}`);
    const s = data.summary;
    document.getElementById("an-sent").textContent = s.sent;
    document.getElementById("an-opens").textContent = s.opens;
    document.getElementById("an-clicks").textContent = s.clicks;
    document.getElementById("an-unique").textContent = s.unique_opened;
    document.getElementById("an-rate").textContent =
      s.sent > 0 ? `${Math.round(s.open_rate * 100)}%` : "—";

    renderAnalyticsChart(data.timeseries, range);
    renderHeatmap(data.heatmap);
  } catch (err) {
    console.error("[Xeven MTracker] Failed to load analytics:", err);
  }
}

function renderAnalyticsChart(timeseries, range) {
  const canvas = document.getElementById("analytics-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const labels = timeseries.map((t) => fmtBucketLabel(t.bucket, range));
  const opens = timeseries.map((t) => t.opens);
  const clicks = timeseries.map((t) => t.clicks);

  if (analyticsChart) analyticsChart.destroy();
  analyticsChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Opens",
          data: opens,
          borderColor: "#B23A2E",
          backgroundColor: "#B23A2E",
          tension: 0.25,
        },
        {
          label: "Clicks",
          data: clicks,
          borderColor: "#B3812E",
          backgroundColor: "#B3812E",
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: { legend: { position: "top" } },
    },
  });
}

function renderHeatmap(cells) {
  const container = document.getElementById("heatmap");
  if (!container) return;

  const grid = {};
  let max = 1;
  cells.forEach((c) => {
    grid[`${c.day}-${c.hour}`] = c.count;
    if (c.count > max) max = c.count;
  });

  let html = `<div></div>`;
  for (let h = 0; h < 24; h++) {
    html += `<div class="heatmap-hour-label">${h % 3 === 0 ? h : ""}</div>`;
  }

  for (let d = 0; d < 7; d++) {
    html += `<div class="heatmap-day-label">${DAY_LABELS[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const count = grid[`${d}-${h}`] || 0;
      const alpha = count === 0 ? 0 : 0.15 + 0.85 * (count / max);
      const bg = count === 0 ? "var(--rule)" : `rgba(178, 58, 46, ${alpha.toFixed(2)})`;
      html += `<div class="heatmap-cell" style="background:${bg}" title="${DAY_LABELS[d]} ${h}:00 — ${count} event(s)"></div>`;
    }
  }

  container.innerHTML = html;
}

// ---- Notifications ----

const ALL_PROVIDERS = ["zoho", "gmail", "hostinger"];
const PROVIDER_LABELS = { zoho: "Zoho Mail", gmail: "Gmail", hostinger: "Hostinger" };
function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

function notifTypeBadge(type) {
  return type === "click"
    ? `<span class="notif-type-badge notif-type-click"><svg class="icon"><use href="#icon-cursor"/></svg> CLICK</span>`
    : `<span class="notif-type-badge notif-type-open"><svg class="icon"><use href="#icon-eye"/></svg> OPEN</span>`;
}

async function loadBothProviderBadges() {
  await Promise.all(ALL_PROVIDERS.map((p) => updateProviderBadge(p)));
  // The Alerts sub-tab badge always reflects whichever provider is
  // currently selected, since that's the mailbox the Alerts list is showing.
  try {
    const { count } = await api(`/api/notifications/unread-count?provider=${currentProvider}`);
    const badge = document.getElementById("notif-badge");
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count);
    }
  } catch (e) {
    console.error("[Xeven MTracker] Failed to load unread count:", e);
  }
}

async function updateProviderBadge(provider) {
  try {
    const { count } = await api(`/api/notifications/unread-count?provider=${provider}`);
    const badge = document.getElementById(`notif-badge-${provider}`);
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count);
    }
  } catch (e) {
    console.error(`[Xeven MTracker] Failed to load ${provider} unread count:`, e);
  }
}

function buildNotifQuery() {
  const params = new URLSearchParams();
  const type = document.getElementById("notif-filter-type")?.value;
  const unread = document.getElementById("notif-filter-unread")?.value;
  params.set("provider", currentProvider);
  if (type) params.set("type", type);
  if (unread) params.set("unread", unread);
  return params.toString();
}

async function loadNotifications() {
  const body = document.getElementById("notif-body");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="7" class="empty-row">Loading…</td></tr>`;

  try {
    const query = buildNotifQuery();
    const { notifications } = await api(`/api/notifications${query ? "?" + query : ""}`);

    if (notifications.length === 0) {
      body.innerHTML = `<tr><td colspan="7" class="empty-row">No notifications yet. You'll see one here the first time an email is opened, and every time a link is clicked.</td></tr>`;
      notifSelectedIds.clear();
      updateNotifBulkBar();
      return;
    }

    body.innerHTML = notifications
      .map((n) => {
        const detail =
          n.type === "click" && n.url
            ? escapeHtml(n.url)
            : escapeHtml((n.recipients || []).join(", "));
        return `
      <tr data-id="${n.id}" class="${n.is_read ? "" : "notif-unread-row"}">
        <td><input type="checkbox" class="notif-row-checkbox" data-id="${n.id}" ${notifSelectedIds.has(String(n.id)) ? "checked" : ""} /></td>
        <td><button class="bell-btn ${n.is_read ? "" : "unread"}" data-id="${n.id}" data-read="${n.is_read}" title="${n.is_read ? "Mark unread" : "Mark read"}"><svg class="icon"><use href="#icon-bell"/></svg></button></td>
        <td>${notifTypeBadge(n.type)}</td>
        <td class="subject-cell">${escapeHtml(n.subject || "(no subject)")}</td>
        <td class="notif-detail-cell">${detail}</td>
        <td class="mono">${fmtDate(n.created_at)}</td>
        <td><button class="row-delete-btn" data-id="${n.id}" title="Delete"><svg class="icon"><use href="#icon-x"/></svg></button></td>
      </tr>`;
      })
      .join("");

    document.querySelectorAll(".bell-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const isRead = btn.dataset.read === "true";
        try {
          await api(`/api/notifications/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ is_read: !isRead }),
          });
          loadNotifications();
          loadBothProviderBadges();
        } catch (err) {
          alert(`Failed to update notification: ${err.message}`);
        }
      });
    });

    document.querySelectorAll("#notif-body .row-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm("Delete this notification?")) return;
        await deleteNotifications([id]);
      });
    });

    document.querySelectorAll(".notif-row-checkbox").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) notifSelectedIds.add(id);
        else notifSelectedIds.delete(id);
        updateNotifBulkBar();
      });
    });

    const selectAll = document.getElementById("notif-select-all");
    if (selectAll) selectAll.checked = false;
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
  }
}

function updateNotifBulkBar() {
  const row = document.getElementById("notif-bulk-actions-row");
  const countEl = document.getElementById("notif-bulk-selected-count");
  const count = notifSelectedIds.size;
  if (row) row.hidden = count === 0;
  if (countEl) countEl.textContent = `${count} selected`;
}

async function deleteNotifications(ids) {
  try {
    if (ids.length === 1) {
      await api(`/api/notifications/${ids[0]}`, { method: "DELETE" });
    } else {
      await api(`/api/notifications/bulk-delete`, {
        method: "POST",
        body: JSON.stringify({ ids: ids.map((id) => parseInt(id, 10)) }),
      });
    }
    ids.forEach((id) => notifSelectedIds.delete(id));
    updateNotifBulkBar();
    loadNotifications();
    loadBothProviderBadges();
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

// ---- History (flat open/click event log) ----

function buildHistoryQuery() {
  const params = new URLSearchParams();
  const type = document.getElementById("history-filter-type")?.value;
  const search = document.getElementById("history-filter-search")?.value;
  const from = document.getElementById("history-filter-from")?.value;
  const to = document.getElementById("history-filter-to")?.value;

  params.set("provider", currentProvider);
  if (type) params.set("type", type);
  if (search) params.set("search", search);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params.toString();
}

async function loadHistory() {
  const body = document.getElementById("history-body");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="5" class="empty-row">Loading…</td></tr>`;

  try {
    const query = buildHistoryQuery();
    const { events } = await api(`/api/history${query ? "?" + query : ""}`);

    if (events.length === 0) {
      const label = providerLabel(currentProvider);
      body.innerHTML = `<tr><td colspan="5" class="empty-row">No open/click events yet for ${label}.</td></tr>`;
      return;
    }

    body.innerHTML = events
      .map((ev) => {
        const detail =
          ev.type === "click" && ev.url ? escapeHtml(ev.url) : escapeHtml(ev.ip || "—");
        return `
      <tr>
        <td>${notifTypeBadge(ev.type)}</td>
        <td class="subject-cell">${escapeHtml(ev.subject || "(no subject)")}</td>
        <td class="recipients-cell">${escapeHtml((ev.recipients || []).join(", "))}</td>
        <td class="notif-detail-cell">${detail}</td>
        <td class="mono">${fmtDate(ev.ts)}</td>
      </tr>`;
      })
      .join("");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ==== Wiring — each block is isolated so one bad selector can't break the rest ====

safeRun("login form", () => {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      loginForm.reset();
      showDashboard(email);
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    }
  });
});

safeRun("logout button", () => {
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    showLogin();
  });
});

safeRun("filter buttons", () => {
  document.getElementById("filter-apply").addEventListener("click", loadEmails);
  document.getElementById("refresh-btn").addEventListener("click", () => {
    loadStats();
    loadEmails();
  });
  document.getElementById("filter-clear").addEventListener("click", () => filterByStatus(""));
});

safeRun("bulk actions", () => {
  const selectAll = document.getElementById("select-all");
  selectAll.addEventListener("change", (e) => {
    document.querySelectorAll(".row-checkbox").forEach((cb) => {
      cb.checked = e.target.checked;
      const id = cb.dataset.id;
      if (e.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
    updateBulkBar();
  });

  document.getElementById("bulk-delete-btn").addEventListener("click", () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} tracked email(s)? This cannot be undone.`)) return;
    deleteEmails(Array.from(selectedIds));
  });
});

safeRun("stat card filters", () => {
  document.getElementById("stat-card-sent").addEventListener("click", () => filterByStatus(""));
  document.getElementById("stat-card-opened").addEventListener("click", () => filterByStatus("opened"));
  document.getElementById("stat-card-unopened").addEventListener("click", () => filterByStatus("sent"));
  document.getElementById("stat-card-clicked").addEventListener("click", () => filterByStatus("clicked"));
});

safeRun("detail panel", () => {
  document.getElementById("detail-close").addEventListener("click", () => {
    detailPanel.hidden = true;
    currentDetailId = null;
  });

  document.getElementById("detail-save-notes").addEventListener("click", async () => {
    if (!currentDetailId) return;
    const notes = document.getElementById("detail-notes").value;
    try {
      await api(`/api/emails/${currentDetailId}`, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      });
    } catch (err) {
      alert(`Failed to save note: ${err.message}`);
    }
  });

  document.getElementById("detail-delete").addEventListener("click", async () => {
    if (!currentDetailId) return;
    if (!confirm("Delete this tracked email? This cannot be undone.")) return;
    await deleteEmails([currentDetailId]);
  });
});

safeRun("provider + settings tab navigation", () => {
  document.querySelectorAll("#provider-tabs .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.provider) showProviderTab(btn.dataset.provider);
      else if (btn.dataset.view === "settings") showSettingsTab();
    });
  });
});

safeRun("sub-tab navigation", () => {
  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => showSubView(btn.dataset.subview));
  });
});

safeRun("history filters", () => {
  document.getElementById("history-filter-apply").addEventListener("click", loadHistory);
  document.getElementById("history-filter-clear").addEventListener("click", () => {
    ["history-filter-type", "history-filter-search", "history-filter-from", "history-filter-to"].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }
    );
    loadHistory();
  });
});

safeRun("analytics range buttons", () => {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => loadAnalytics(btn.dataset.range));
  });
});

safeRun("notifications filters", () => {
  document.getElementById("notif-filter-apply").addEventListener("click", loadNotifications);
  document.getElementById("notif-mark-all-read").addEventListener("click", async () => {
    try {
      await api("/api/notifications/mark-all-read", { method: "POST" });
      loadNotifications();
      loadBothProviderBadges();
    } catch (err) {
      alert(`Failed to mark all as read: ${err.message}`);
    }
  });
});

safeRun("notifications bulk actions", () => {
  const selectAll = document.getElementById("notif-select-all");
  selectAll.addEventListener("change", (e) => {
    document.querySelectorAll(".notif-row-checkbox").forEach((cb) => {
      cb.checked = e.target.checked;
      const id = cb.dataset.id;
      if (e.target.checked) notifSelectedIds.add(id);
      else notifSelectedIds.delete(id);
    });
    updateNotifBulkBar();
  });

  document.getElementById("notif-bulk-delete-btn").addEventListener("click", () => {
    if (notifSelectedIds.size === 0) return;
    if (!confirm(`Delete ${notifSelectedIds.size} notification(s)? This cannot be undone.`)) return;
    deleteNotifications(Array.from(notifSelectedIds));
  });
});

safeRun("settings form", () => {
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  document.getElementById("settings-test-email").addEventListener("click", sendTestEmail);
});

// Auth check is NOT inside safeRun and is NOT gated behind anything above —
// it always runs, no matter what else on this page succeeds or fails.
checkSession();
