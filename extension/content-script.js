// Xeven MTracker — content script
//
// Zoho's compose editor is the <body> of a separate document loaded inside
// an <iframe> (Zoho's rich-text editor — identifiable by
// aria-label="Rich text editor area" / class "ze_body"). Everything else
// (To/Subject fields, the Send button, the toolbar) lives in the *parent*
// page, outside that iframe. So detection has two halves:
//   1. Find the editor iframe and grab its contentDocument.body directly
//      (same-origin, so this is plain DOM access — no messaging needed).
//   2. Walk up from the iframe element itself, in the parent document, to
//      find the surrounding compose window (Send button, toolbar, To/Subject
//      fields).
//
// Zoho can change this markup at any time. If detection breaks, open
// DevTools > Elements, click into the message body, and check whether it's
// still an iframe with the same aria-label/class — update the selectors
// below (isComposeEditorBody) if not.

const trackedContainers = new Map(); // containerEl -> { enabled, toggleEl, bodyEl }
const bypassOnce = new WeakSet();
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function log(...args) {
  console.log("[Xeven MTracker]", ...args);
}

function showToast(message, isError) {
  const toast = document.createElement("div");
  toast.className = "zmt-toast" + (isError ? " zmt-toast-error" : "");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ---- Finding the compose editor iframe ----

function isComposeEditorBody(body) {
  if (!body) return false;
  if (body.getAttribute("contenteditable") !== "true") return false;
  const aria = (body.getAttribute("aria-label") || "").toLowerCase();
  const hasEditorClass = body.classList && body.classList.contains("ze_body");
  return aria.includes("editor") || hasEditorClass;
}

function getIframeBody(iframe) {
  try {
    return iframe.contentDocument && iframe.contentDocument.body;
  } catch (e) {
    return null; // cross-origin — not a Zoho editor frame we can use
  }
}

// ---- Finding the surrounding compose window (in the parent document) ----

function isSendButton(el) {
  if (!el || el.children.length > 2) return false; // avoid matching big wrapper divs
  const text = (el.textContent || "").trim().toLowerCase();
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  const looksLikeSend = text === "send" || aria === "send" || aria.includes("send email");
  const isSendLater = text.includes("later") || aria.includes("later") || text.includes("schedule");
  return looksLikeSend && !isSendLater;
}

function findSendButtons(container) {
  return Array.from(container.querySelectorAll("button, [role='button'], span, div")).filter(
    isSendButton
  );
}

function findComposeContainer(iframeEl) {
  let el = iframeEl.parentElement;
  let depth = 0;
  while (el && depth < 12) {
    if (findSendButtons(el).length > 0) return el;
    el = el.parentElement;
    depth++;
  }
  // Fallback: go up a fixed number of levels from the iframe so the toggle
  // has somewhere reasonable to attach even if no Send button was found yet
  // (it may render slightly later — the click interceptor re-scans by
  // container on every click anyway).
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
    container.querySelector("input[aria-label*='subject' i]") ||
    container.querySelector("input[placeholder*='subject' i]") ||
    container.querySelector("input[name*='subject' i]");
  return el ? el.value || "" : "";
}

function findFromAddress(container) {
  const el =
    container.querySelector("[aria-label*='From' i] input") ||
    container.querySelector("[aria-label*='From' i]") ||
    container.querySelector("[class*='from' i]");
  if (!el) return null;
  const text = el.value || el.textContent || "";
  const match = text.match(EMAIL_RE);
  return match ? match[0].toLowerCase() : null;
}

// Pulls every email-shaped string out of a subtree — checking not just
// visible text but also title/aria-label/data-value/value attributes, since
// chip-based recipient widgets often keep the real address in an attribute
// (for a tooltip) while only showing a display name in the text.
function extractEmailsFromScope(scope) {
  if (!scope) return [];
  const found = new Set();
  const consider = (str) => {
    if (!str) return;
    const matches = str.match(EMAIL_RE);
    if (matches) matches.forEach((m) => found.add(m));
  };

  consider(scope.innerText || scope.textContent);
  scope.querySelectorAll("[title], [aria-label], [data-value], input, textarea").forEach((el) => {
    consider(el.getAttribute("title"));
    consider(el.getAttribute("aria-label"));
    consider(el.getAttribute("data-value"));
    consider(el.value);
  });

  return Array.from(found);
}

function findRecipients(container) {
  const fromAddr = findFromAddress(container);
  const excludeFrom = (list) => list.filter((a) => a.toLowerCase() !== fromAddr);

  // Zoho's To field: a combobox <input> (data-testid="com_To_field",
  // aria-label="To Recipients") that only holds text being typed — already
  // selected recipients render as separate chips, not in this input's
  // value. aria-owns/aria-controls on it usually points at the id of the
  // chip/listbox container, so check that first, then widen outward from
  // the input itself if that doesn't resolve.
  const toInput = container.querySelector(
    "[data-testid='com_To_field'], input[aria-label*='To Recipients' i], input[aria-label='To' i], input[aria-label*='To' i]"
  );

  const scopes = [];

  if (toInput) {
    ["aria-owns", "aria-controls"].forEach((attr) => {
      const id = toInput.getAttribute(attr);
      if (id) {
        const el = document.getElementById(id);
        if (el) scopes.push(el);
      }
    });

    let el = toInput.parentElement;
    let depth = 0;
    while (el && depth < 6) {
      scopes.push(el);
      el = el.parentElement;
      depth++;
    }
  }

  for (const scope of scopes) {
    const list = excludeFrom(extractEmailsFromScope(scope));
    if (list.length > 0) return list;
  }

  // Last resort: the whole compose window.
  return excludeFrom(extractEmailsFromScope(container));
}

// ---- Toggle button ----

function addToggleButton(container, bodyEl) {
  if (trackedContainers.has(container)) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "zmt-toggle";
  toggle.textContent = "Track: Off";

  const state = { enabled: false, toggleEl: toggle, bodyEl };
  trackedContainers.set(container, state);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.enabled = !state.enabled;
    toggle.textContent = state.enabled ? "Track: On" : "Track: Off";
    toggle.classList.toggle("zmt-on", state.enabled);
  });

  const toolbar = findToolbar(container);
  if (toolbar) {
    toolbar.appendChild(toggle);
  } else {
    toggle.classList.add("zmt-toggle-floating");
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(toggle);
  }

  log("Attached Track toggle to a compose window.");
}

// ---- Injecting the pixel + rewriting links (inside the iframe's own document) ----

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
      // Happens when the extension was reloaded/updated after this tab was
      // already open — this tab's connection to the extension is dead.
      // Refreshing the tab (not just the compose window) fixes it.
      return reject(new Error("Extension was updated — refresh this Zoho Mail tab and try again."));
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
      reject(new Error("Extension was updated — refresh this Zoho Mail tab and try again."));
    }
  });
}

async function handleTrackedSend(container, bodyEl, clickedEl) {
  const subject = findSubjectValue(container);
  const recipients = findRecipients(container);

  if (recipients.length === 0) {
    showToast("Xeven MTracker: couldn't detect recipients, sending untracked.", true);
    resend(clickedEl);
    return;
  }

  try {
    const data = await sendMessage("CREATE_TRACKED_EMAIL", {
      subject,
      recipients,
      sender: null,
      provider: "zoho",
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

document.addEventListener(
  "click",
  (e) => {
    if (bypassOnce.has(e.target)) {
      bypassOnce.delete(e.target);
      return;
    }

    for (const [container, state] of trackedContainers.entries()) {
      if (!container.contains(e.target)) continue;

      const sendButtons = findSendButtons(container);
      const clickedSend = sendButtons.find((b) => b === e.target || b.contains(e.target));
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
  true // capture phase — see the click before Zoho's own handler
);

// ---- Watch for new compose windows / editor iframes ----

function tryAttachIframe(iframe) {
  if (iframe.dataset.zmtChecked === "1") return;

  const body = getIframeBody(iframe);
  if (!body) {
    // Iframe may not have finished loading yet — retry once it does.
    iframe.addEventListener(
      "load",
      () => {
        const loadedBody = getIframeBody(iframe);
        if (isComposeEditorBody(loadedBody)) {
          iframe.dataset.zmtChecked = "1";
          const container = findComposeContainer(iframe);
          addToggleButton(container, loadedBody);
        }
      },
      { once: true }
    );
    return;
  }

  if (!isComposeEditorBody(body)) return;

  iframe.dataset.zmtChecked = "1";
  const container = findComposeContainer(iframe);
  addToggleButton(container, body);
}

function scan() {
  document.querySelectorAll("iframe").forEach(tryAttachIframe);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();

log("Loaded. Open a compose window in Zoho Mail to see the Track toggle.");
