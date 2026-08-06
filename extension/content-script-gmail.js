// Xeven MTracker — Gmail content script
//
// Unlike Zoho, Gmail's compose editor is NOT inside an iframe — the message
// body is a plain contenteditable <div> (aria-label="Message Body") sitting
// directly in the page's own DOM. That makes this script simpler than the
// Zoho one: no cross-document access needed, just:
//   1. Find contenteditable "Message Body" divs anywhere on the page.
//   2. Walk up from each one to find its compose window (the ancestor that
//      also contains a Send button).
//   3. Attach a Track toggle to that compose window's toolbar.
//
// Gmail's own class names are short, obfuscated, and change without notice
// — every selector below deliberately avoids them in favor of stable
// attributes (aria-label, name) and, for recipients, a broad multi-attribute
// scan (see extractEmailsFromScope) rather than betting on one exact
// attribute, since Gmail's recipient-chip markup has changed more than
// once (see findRecipients for details). If detection breaks after a
// Gmail update, open DevTools > Elements on a compose window and re-check
// these first.
//
// Note: aria-label values are in the Gmail UI's display language. This
// script is written for English ("Message Body", "Send"); Gmail running in
// another language will need the strings below adjusted to match.

const trackedContainers = new Map(); // containerEl -> { enabled, toggleEl, bodyEl }
const bypassOnce = new WeakSet();
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function log(...args) {
  console.log("[Xeven MTracker/Gmail]", ...args);
}

function showToast(message, isError) {
  const toast = document.createElement("div");
  toast.className = "gmt-toast" + (isError ? " gmt-toast-error" : "");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ---- Finding the compose message body ----

function isComposeBody(el) {
  if (!el) return false;
  if (el.getAttribute("contenteditable") !== "true") return false;
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  return aria.includes("message body");
}

// ---- Finding the surrounding compose window ----

function isSendButton(el) {
  if (!el || el.children.length > 3) return false; // avoid matching big wrapper divs
  const text = (el.textContent || "").trim().toLowerCase();
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  const tooltip = (el.getAttribute("data-tooltip") || "").toLowerCase();
  const looksLikeSend =
    text === "send" || aria.startsWith("send") || tooltip.startsWith("send");
  const isScheduleOrMore =
    aria.includes("schedule") || tooltip.includes("schedule") || aria.includes("more send");
  return looksLikeSend && !isScheduleOrMore;
}

function findSendButtons(container) {
  return Array.from(container.querySelectorAll("div[role='button'], button")).filter(isSendButton);
}

// Kept intentionally NARROW and fast: this container is re-checked on every
// single click anywhere on the page (see the document click listener
// below), so it must stay cheap to search. An earlier version required
// this same container to also contain the To/Cc/Bcc fields, which on Gmail
// can force the walk-up to accept a much larger ancestor — every click
// anywhere in that much bigger subtree then re-runs a full
// querySelectorAll here, which is exactly why Send felt like it hung.
// Recipients are instead found by a *separate*, wider search — see
// findRecipients — that only runs once, at the moment Send is actually
// clicked, where the extra cost doesn't matter.
function findComposeContainer(bodyEl) {
  const dialog = bodyEl.closest("[role='dialog']");
  if (dialog && findSendButtons(dialog).length > 0) return dialog;

  let el = bodyEl.parentElement;
  let depth = 0;
  while (el && depth < 16) {
    if (findSendButtons(el).length > 0) return el;
    el = el.parentElement;
    depth++;
  }
  return bodyEl.parentElement ? bodyEl.parentElement.parentElement || bodyEl.parentElement : bodyEl;
}

function findToolbar(container) {
  return (
    container.querySelector("[role='toolbar']") ||
    container.querySelector("[class*='toolbar' i]") ||
    null
  );
}

function findSubjectValue(container) {
  // "subjectbox" is a long-standing, stable Gmail attribute name.
  const el = container.querySelector("input[name='subjectbox']");
  return el ? el.value || "" : "";
}

// Gmail's recipient chips have gone through several DOM redesigns over the
// years (the classic layout put a plain "email" attribute right on the
// chip; the newer PeopleKit-based "To"/"Cc"/"Bcc" combobox — recognizable
// by a peoplekit-id attribute on the <input> — does not always do that).
// Rather than betting on one exact attribute, this pulls every
// email-shaped string out of a broad set of places addresses are known to
// end up (attributes used for hovercards/accessibility, plus visible
// text), then falls back to progressively wider DOM scopes if the narrow
// one comes up empty. This is the same defensive strategy the Zoho script
// uses for the same reason: whatever exact markup a mail client ships,
// the real address has to be *somewhere* in the DOM for accessibility.
function extractEmailsFromScope(scope) {
  if (!scope) return [];
  const found = new Set();
  const consider = (str) => {
    if (!str) return;
    const matches = String(str).match(EMAIL_RE);
    if (matches) matches.forEach((m) => found.add(m.toLowerCase()));
  };

  consider(scope.getAttribute && scope.getAttribute("email"));
  consider(scope.innerText || scope.textContent);

  scope
    .querySelectorAll(
      "[email], [title], [aria-label], [data-hovercard-id], [data-name], [data-email], input, textarea"
    )
    .forEach((el) => {
      consider(el.getAttribute("email"));
      consider(el.getAttribute("title"));
      consider(el.getAttribute("aria-label"));
      consider(el.getAttribute("data-hovercard-id"));
      consider(el.getAttribute("data-name"));
      consider(el.getAttribute("data-email"));
      consider(el.value);
    });

  return Array.from(found);
}

// Recipient inputs are labeled "To recipients" / "Cc recipients" /
// "Bcc recipients" (or sometimes just "To"/"Cc"/"Bcc") in Gmail's English
// UI. For each one found, this collects several candidate scopes to search
// — walking up its ancestor chain (where already-selected chips actually
// live in the PeopleKit layout) and, if present, whatever aria-owns /
// aria-controls points at (the classic layout's chip list, or a
// suggestions popup in the newer one — cheap to check either way).
// `root` is where querySelectorAll runs to *find* the inputs; `stopAt` is
// where the ancestor walk-up stops. Kept as separate params so the
// document-wide fallback below can reuse this without needing a "container"
// that actually bounds anything.
function findRecipientScopes(root, stopAt) {
  const inputs = Array.from(
    root.querySelectorAll(
      "input[aria-label*='recipients' i], input[aria-label='To' i], input[aria-label='Cc' i], input[aria-label='Bcc' i]"
    )
  );
  const scopes = [];

  inputs.forEach((input) => {
    ["aria-owns", "aria-controls"].forEach((attr) => {
      const id = input.getAttribute(attr);
      if (id) {
        const el = document.getElementById(id);
        if (el) scopes.push(el);
      }
    });

    let el = input.parentElement;
    let depth = 0;
    while (el && depth < 10 && el !== stopAt) {
      scopes.push(el);
      el = el.parentElement;
      depth++;
    }
  });

  return scopes;
}

// `container` here is the small, fast, click-detection container — it may
// not actually contain the To/Cc/Bcc fields (see findComposeContainer's
// comment). This is only called once, at the moment Send is clicked, so —
// unlike the click-interception path — it's fine to fall back to searching
// the whole document if the narrow container comes up empty.
function findRecipients(container) {
  for (const scope of findRecipientScopes(container, container)) {
    const emails = extractEmailsFromScope(scope);
    if (emails.length > 0) return emails;
  }

  const narrowEmails = extractEmailsFromScope(container);
  if (narrowEmails.length > 0) return narrowEmails;

  // Fallback: the To/Cc/Bcc fields live outside this compose window's
  // Send-button ancestor. Search the whole document — there's normally
  // only one compose window's recipient fields visible at a time, so this
  // is safe in practice even though it's not scoped to `container`.
  for (const scope of findRecipientScopes(document, document.body)) {
    const emails = extractEmailsFromScope(scope);
    if (emails.length > 0) return emails;
  }

  return []; // genuinely couldn't find recipients anywhere
}

// ---- Toggle button ----

function addToggleButton(container, bodyEl) {
  if (trackedContainers.has(container)) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "gmt-toggle";
  toggle.textContent = "Track: Off";

  const state = { enabled: false, toggleEl: toggle, bodyEl };
  trackedContainers.set(container, state);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.enabled = !state.enabled;
    toggle.textContent = state.enabled ? "Track: On" : "Track: Off";
    toggle.classList.toggle("gmt-on", state.enabled);
  });

  const toolbar = findToolbar(container);
  if (toolbar) {
    toolbar.appendChild(toggle);
  } else {
    toggle.classList.add("gmt-toggle-floating");
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(toggle);
  }

  log("Attached Track toggle to a compose window.");
}

// ---- Injecting the pixel + rewriting links ----
// No iframe indirection needed here — bodyEl is a normal element in the
// page's own document.

function injectPixel(bodyEl, pixelUrl) {
  const img = document.createElement("img");
  img.src = pixelUrl;
  img.width = 1;
  img.height = 1;
  img.alt = "";
  img.style.display = "none";
  bodyEl.appendChild(img);
}

function rewriteLinks(bodyEl, clickBaseUrl) {
  const anchors = bodyEl.querySelectorAll("a[href^='http']");
  anchors.forEach((a, i) => {
    const original = a.getAttribute("href");
    if (!original || original.includes(clickBaseUrl)) return;
    a.setAttribute("href", `${clickBaseUrl}?url=${encodeURIComponent(original)}&linkId=${i}`);
  });
}

function sendMessage(type, payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime || !chrome.runtime.id) {
      return reject(new Error("Extension was updated — refresh this Gmail tab and try again."));
    }
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response || !response.ok) {
          return reject(new Error((response && response.error) || "Unknown error"));
        }
        resolve(response.data);
      });
    } catch (err) {
      reject(new Error("Extension was updated — refresh this Gmail tab and try again."));
    }
  });
}

async function handleTrackedSend(container, bodyEl, clickedEl) {
  const subject = findSubjectValue(container);
  const recipients = findRecipients(container);

  if (recipients.length === 0) {
    const candidateInputs = Array.from(
      container.querySelectorAll(
        "input[aria-label*='recipients' i], input[aria-label='To' i], input[aria-label='Cc' i], input[aria-label='Bcc' i]"
      )
    );
    console.log(
      "[Xeven MTracker/Gmail] No recipients detected.",
      "\nRecipient-labeled inputs found in container:", candidateInputs.length,
      "\nContainer outerHTML (truncated):", container.outerHTML.slice(0, 3000),
      "\nContainer element (expand in console to inspect live):", container
    );
    showToast("Xeven MTracker: couldn't detect recipients, sending untracked.", true);
    resend(clickedEl);
    return;
  }

  try {
    const data = await sendMessage("CREATE_TRACKED_EMAIL", {
      subject,
      recipients,
      sender: null,
      provider: "gmail",
    });
    injectPixel(bodyEl, data.pixelUrl);
    rewriteLinks(bodyEl, data.clickBaseUrl);
  } catch (err) {
    log("Failed to attach tracking:", err.message);
    showToast(`Xeven MTracker: ${err.message} — sending untracked.`, true);
  }

  resend(clickedEl);
}

function resend(clickedEl) {
  bypassOnce.add(clickedEl);
  clickedEl.click();
}

// ---- Global send interceptor ----

// Cached per compose window so the (potentially expensive) button search
// doesn't re-run on every single click anywhere on the page — only once,
// and again only if the cached buttons stop matching (e.g. Gmail
// re-rendered the toolbar).
function findClickedSendButton(container, state, target) {
  if (!state.sendButtonsCache) state.sendButtonsCache = findSendButtons(container);
  let match = state.sendButtonsCache.find((b) => b === target || b.contains(target));
  if (!match) {
    state.sendButtonsCache = findSendButtons(container);
    match = state.sendButtonsCache.find((b) => b === target || b.contains(target));
  }
  return match;
}

document.addEventListener(
  "click",
  (e) => {
    if (bypassOnce.has(e.target)) {
      bypassOnce.delete(e.target);
      return;
    }

    for (const [container, state] of trackedContainers.entries()) {
      if (!container.contains(e.target)) continue;

      const clickedSend = findClickedSendButton(container, state, e.target);
      if (!clickedSend) continue;

      if (!state.enabled) return; // tracking off for this compose — let it send normally

      if (!state.bodyEl) {
        showToast("Xeven MTracker: couldn't find the message body, sending untracked.", true);
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      handleTrackedSend(container, state.bodyEl, clickedSend);
      return;
    }
  },
  true // capture phase — see the click before Gmail's own handler
);

// ---- Watch for new compose windows ----

function tryAttachBody(el) {
  if (el.dataset.gmtChecked === "1") return;
  if (!isComposeBody(el)) return;

  el.dataset.gmtChecked = "1";
  const container = findComposeContainer(el);
  addToggleButton(container, el);
}

function scan() {
  document.querySelectorAll("div[contenteditable='true']").forEach(tryAttachBody);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();

log("Loaded. Open a compose window in Gmail to see the Track toggle.");
