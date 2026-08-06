// Xeven MTracker — Hostinger Webmail (mail.hostinger.com) content script
//
// Confirmed from real DOM (via user inspection):
//   To:      <input id="to" data-qa="composer-to-input" ...>                (plain text input)
//   Subject: <input id="subject" data-qa="composer-subject" ...>
//   Body:    <iframe data-qa="composer-content-iframe" sandbox="allow-same-origin" ...>
//   Send:    <button class="... h-split-button__primary" ...><span>Send</span></button>
//
// The body is an <iframe> — same overall architecture as Zoho (a separate
// document loaded inside an iframe), NOT like Gmail's plain contenteditable
// div. This version replaces an earlier one that assumed a contenteditable
// body and never found the real editor as a result — that's why the Track
// toggle wasn't appearing at all. Detection now has two halves, mirroring
// content-script.js:
//   1. Find the composer iframe by its data-qa attribute, and read
//      iframe.contentDocument.body directly (same-origin, thanks to the
//      "allow-same-origin" sandbox flag — plain DOM access, no messaging).
//   2. Walk up from the iframe in the parent document to find the
//      surrounding compose window (Send button, toolbar, To/Subject).
//
// If Hostinger changes this markup, open DevTools > Elements on a compose
// window and re-check these attributes first.

const trackedContainers = new Map(); // containerEl -> { enabled, toggleEl, bodyEl }
const bypassOnce = new WeakSet();
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function log(...args) {
  console.log("[Xeven MTracker/Hostinger]", ...args);
}

function showToast(message, isError) {
  const toast = document.createElement("div");
  toast.className = "xmt-hostinger-toast" + (isError ? " xmt-hostinger-toast-error" : "");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ---- Finding the composer iframe ----

function isComposerIframe(iframe) {
  return iframe.getAttribute("data-qa") === "composer-content-iframe";
}

function getIframeBody(iframe) {
  try {
    return iframe.contentDocument && iframe.contentDocument.body;
  } catch (e) {
    return null; // cross-origin — shouldn't happen given allow-same-origin, but don't crash if it does
  }
}

// ---- Finding the surrounding compose window (in the parent document) ----

function isSendButton(el) {
  if (!el || el.children.length > 4) return false; // avoid matching big wrapper divs
  const text = (el.textContent || "").trim().toLowerCase();
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  const looksLikeSend = text === "send" || aria.startsWith("send");
  const isScheduleOrMore = aria.includes("schedule") || aria.includes("more send") || text.includes("schedule");
  return looksLikeSend && !isScheduleOrMore;
}

function findSendButtons(container) {
  return Array.from(container.querySelectorAll("button, [role='button']")).filter(isSendButton);
}

// Kept NARROW and fast on purpose — this container is re-checked on every
// click anywhere on the page (see the click interceptor below), so an
// oversized container here is exactly what caused Gmail's Send button to
// feel like it hung after a similar "require both Send AND To" change.
// Recipients are found by a separate, wider search that only runs once, at
// the moment Send is actually clicked (see findRecipients's document-wide
// fallback), where the extra cost doesn't matter.
function findComposeContainer(iframeEl) {
  const shortcut = iframeEl.closest("[data-qa='composer'], [data-qa*='composer-panel' i], [role='dialog']");
  if (shortcut && findSendButtons(shortcut).length > 0) return shortcut;

  let el = iframeEl.parentElement;
  let depth = 0;
  while (el && depth < 20) {
    if (findSendButtons(el).length > 0) return el;
    el = el.parentElement;
    depth++;
  }
  return iframeEl.parentElement ? iframeEl.parentElement.parentElement || iframeEl.parentElement : iframeEl;
}

function findToolbar(container) {
  return (
    container.querySelector("[role='toolbar']") ||
    container.querySelector("[class*='toolbar' i]") ||
    null
  );
}

function findSubjectValue(container) {
  const el =
    container.querySelector("input[data-qa='composer-subject'], input#subject") ||
    document.querySelector("input[data-qa='composer-subject'], input#subject");
  return el ? el.value || "" : "";
}

function extractEmailsFromScope(scope) {
  if (!scope) return [];
  const found = new Set();
  const consider = (str) => {
    if (!str) return;
    const matches = String(str).match(EMAIL_RE);
    if (matches) matches.forEach((m) => found.add(m.toLowerCase()));
  };

  consider(scope.value);
  consider(scope.getAttribute && scope.getAttribute("title"));
  consider(scope.innerText || scope.textContent);
  scope.querySelectorAll("[title], [aria-label], [data-email], input, textarea").forEach((el) => {
    consider(el.getAttribute("title"));
    consider(el.getAttribute("aria-label"));
    consider(el.getAttribute("data-email"));
    consider(el.value);
  });

  return Array.from(found);
}

function findToInput(container) {
  // `container` (the click-detection ancestor) may not actually contain the
  // To field — see findComposeContainer's comment — so fall back to a
  // document-wide search. Only called once per actual send attempt, so the
  // wider search is cheap in practice (there's normally one visible
  // compose window's To field at a time).
  return (
    container.querySelector("input[data-qa='composer-to-input'], input#to") ||
    document.querySelector("input[data-qa='composer-to-input'], input#to")
  );
}

function findRecipients(container) {
  const toInput = findToInput(container);
  if (!toInput) return [];

  // Primary path: plain comma/semicolon-separated text in the input itself
  // (Hostinger's To field, unlike Gmail/Zoho's chip UI, is a plain input).
  const fromValue = extractEmailsFromScope(toInput);
  if (fromValue.length > 0) return fromValue;

  // Fallback: if a recipient becomes a "chip" rendered as a sibling and the
  // input's own value gets cleared, widen outward the same way as Gmail/Zoho.
  let el = toInput.parentElement;
  let depth = 0;
  const stopAt = container.contains(toInput) ? container : document.body;
  while (el && depth < 6 && el !== stopAt) {
    const emails = extractEmailsFromScope(el);
    if (emails.length > 0) return emails;
    el = el.parentElement;
    depth++;
  }

  return extractEmailsFromScope(container);
}

// ---- Toggle button ----

function addToggleButton(container, bodyEl, iframeEl) {
  if (trackedContainers.has(container)) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "xmt-hostinger-toggle";
  toggle.textContent = "Track: Off";

  const state = { enabled: false, toggleEl: toggle, bodyEl, iframeEl };
  trackedContainers.set(container, state);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.enabled = !state.enabled;
    toggle.textContent = state.enabled ? "Track: On" : "Track: Off";
    toggle.classList.toggle("xmt-on", state.enabled);
  });

  const toolbar = findToolbar(container);
  if (toolbar) {
    toolbar.appendChild(toggle);
  } else {
    toggle.classList.add("xmt-hostinger-toggle-floating");
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(toggle);
  }

  log("Attached Track toggle to a compose window.");
}

// ---- Injecting the pixel + rewriting links (inside the iframe's own document) ----
//
// This app (Vue, judging by the data-v-* attributes on its buttons) most
// likely keeps its own copy of the email body in JS state, synced from the
// iframe via input/change events on the editable element — the actual
// network request on Send is built from THAT state, not read fresh off the
// live DOM. A silent DOM mutation (just appendChild, no event) can
// therefore succeed with no error while the email that actually goes out
// never contains the pixel or rewritten links at all — which is exactly
// what "sends fine, dashboard logs it, but opens/clicks never register"
// looks like. Dispatching input/change after mutating nudges any such
// state sync to pick up the change before Send reads it.

function notifyEditorOfChange(bodyEl) {
  const doc = bodyEl.ownerDocument;
  const InputEventCtor = doc.defaultView ? doc.defaultView.Event : Event;
  ["input", "change"].forEach((type) => {
    try {
      bodyEl.dispatchEvent(new InputEventCtor(type, { bubbles: true, cancelable: true }));
    } catch (e) {
      // Best-effort — if the app doesn't listen for this, it's a harmless no-op.
    }
  });
}

function injectPixel(bodyEl, pixelUrl) {
  const doc = bodyEl.ownerDocument;
  const img = doc.createElement("img");
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
      return reject(new Error("Extension was updated — refresh this tab and try again."));
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
      reject(new Error("Extension was updated — refresh this tab and try again."));
    }
  });
}

async function handleTrackedSend(container, state, clickedEl) {
  const subject = findSubjectValue(container);
  const recipients = findRecipients(container);

  if (recipients.length === 0) {
    const toInput = findToInput(container);
    console.log(
      "[Xeven MTracker/Hostinger] No recipients detected.",
      "\nTo input found:", !!toInput,
      "\nTo input value:", toInput ? toInput.value : "(no input found)",
      "\nContainer outerHTML (truncated):", container.outerHTML.slice(0, 3000)
    );
    showToast("Xeven MTracker: couldn't detect recipients, sending untracked.", true);
    resend(clickedEl);
    return;
  }

  // Re-fetch the live body right before mutating it, rather than trusting
  // the reference captured when the toggle was first attached — if Vue
  // re-rendered the iframe in between (e.g. after the user typed), that
  // old reference could point at a detached node that no longer affects
  // what actually gets sent.
  const bodyEl = (state.iframeEl && getIframeBody(state.iframeEl)) || state.bodyEl;

  if (!bodyEl) {
    showToast("Xeven MTracker: couldn't find the message body, sending untracked.", true);
    resend(clickedEl);
    return;
  }

  try {
    const data = await sendMessage("CREATE_TRACKED_EMAIL", {
      subject,
      recipients,
      sender: null,
      provider: "hostinger",
    });
    injectPixel(bodyEl, data.pixelUrl);
    rewriteLinks(bodyEl, data.clickBaseUrl);
    notifyEditorOfChange(bodyEl);
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

// Cached per compose window so the button search doesn't re-run on every
// single click anywhere on the page — only once, and again only if the
// cached buttons stop matching (e.g. the app re-rendered the toolbar).
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

      if (!state.bodyEl && !state.iframeEl) {
        showToast("Xeven MTracker: couldn't find the message body, sending untracked.", true);
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      handleTrackedSend(container, state, clickedSend);
      return;
    }
  },
  true // capture phase — see the click before Hostinger's own handler
);

// ---- Watch for new compose windows / editor iframes ----

function tryAttachIframe(iframe) {
  if (iframe.dataset.xmtChecked === "1") return;
  if (!isComposerIframe(iframe)) return;

  const body = getIframeBody(iframe);
  if (!body) {
    // Iframe may not have finished loading yet — retry once it does.
    iframe.addEventListener(
      "load",
      () => {
        const loadedBody = getIframeBody(iframe);
        if (loadedBody) {
          iframe.dataset.xmtChecked = "1";
          const container = findComposeContainer(iframe);
          addToggleButton(container, loadedBody, iframe);
        }
      },
      { once: true }
    );
    return;
  }

  iframe.dataset.xmtChecked = "1";
  const container = findComposeContainer(iframe);
  addToggleButton(container, body, iframe);
}

function scan() {
  document.querySelectorAll("iframe").forEach(tryAttachIframe);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();

log("Loaded. Open a compose window in Hostinger Webmail to see the Track toggle.");
