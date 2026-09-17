// Popup : liste compacte avec statut, capture unitaire, "Tout capturer".

import { getMeta, getSnippets } from "./storage.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");

const STATUS_LABELS = {
  ok: "up to date",
  capturing: "capturing…",
  session_expired: "session expired",
  selector_not_found: "selector not found",
  error: "error",
};

function relativeTime(timestamp) {
  if (!timestamp) return "never captured";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function stalenessClass(snippet, entry) {
  const status = entry && entry.status;
  if (status && status !== "ok" && status !== "capturing") return "error";
  const capturedAt = (entry && entry.capturedAt) || 0;
  if (!capturedAt) return "error";
  const age = Date.now() - capturedAt;
  const interval = snippet.intervalMinutes * 60000;
  if (age < interval) return "fresh";
  if (age < interval * 3) return "aging";
  return "stale";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function render() {
  const [snippets, meta] = await Promise.all([getSnippets(), getMeta()]);

  countEl.textContent = snippets.length ? `${snippets.length} snippet(s)` : "";
  emptyEl.hidden = snippets.length > 0;
  listEl.replaceChildren();

  for (const snippet of snippets) {
    const entry = meta[snippet.id] || null;
    const status = (entry && entry.status) || "never";
    const busy = status === "capturing" || Boolean(entry && entry.queued);
    const isBad = status !== "ok" && status !== "capturing" && status !== "never";

    const li = el("li");
    li.appendChild(el("span", `dot ${stalenessClass(snippet, entry)}`));

    const main = el("div", "item-main");
    main.appendChild(el("div", "item-name", snippet.name));
    const statusText = `${STATUS_LABELS[status] || "never captured"} · ${relativeTime(
      (entry && entry.capturedAt) || 0
    )}`;
    const statusLine = el("div", `item-status${isBad ? " bad" : ""}`, statusText);
    const tip = [entry && entry.lastError, entry && entry.lastDiag].filter(Boolean).join("\n");
    if (tip) statusLine.title = tip;
    main.appendChild(statusLine);
    li.appendChild(main);

    const openBtn = el("button", "icon-btn", "↗");
    openBtn.type = "button";
    openBtn.title = `Open ${snippet.url}`;
    openBtn.addEventListener("click", () => chrome.tabs.create({ url: snippet.url, active: true }));
    li.appendChild(openBtn);

    const refreshBtn = el("button", "icon-btn", busy ? "…" : "↻");
    refreshBtn.type = "button";
    refreshBtn.disabled = busy;
    refreshBtn.title = busy ? "Capturing…" : "Capture now";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      await chrome.runtime.sendMessage({ type: "captureNow", snippetId: snippet.id });
    });
    li.appendChild(refreshBtn);

    listEl.appendChild(li);
  }
}

const pickErrorEl = document.getElementById("pick-error");

function showPickError(text) {
  pickErrorEl.textContent = text;
  pickErrorEl.hidden = false;
}

// Le popup se ferme dès que la page reprend le focus : c'est le service worker
// qui traite le message `pickerResult`, pas cette page.
document.getElementById("pick-zone").addEventListener("click", async () => {
  pickErrorEl.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showPickError("No active tab.");
      return;
    }
    if (!/^https?:\/\//i.test(tab.url || "")) {
      showPickError(
        "This page cannot be captured: chrome:// pages, the Chrome Web Store and PDFs are not supported."
      );
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    window.close();
  } catch (error) {
    showPickError(`Injection failed: ${error && error.message ? error.message : String(error)}`);
  }
});

document.getElementById("capture-all").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  await chrome.runtime.sendMessage({ type: "captureAll" });
  await render();
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.meta || changes.snippets) render().catch((error) => console.warn("[LLS] popup", error));
});

await render();
