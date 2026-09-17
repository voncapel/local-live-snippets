// Page Options : CRUD des snippets, réglages globaux, picker d'élément,
// import/export JSON de la config (sans images).

import { clearImages, deleteImage } from "./db.js";
import {
  DEFAULT_SNIPPET,
  KEY_META,
  deleteSnippet,
  getMeta,
  getSettings,
  getSnippets,
  normalizeSnippet,
  setSettings,
  setSnippets,
  upsertSnippet,
} from "./storage.js";

const $ = (id) => document.getElementById(id);

const listEl = $("snippet-list");
const listEmptyEl = $("snippet-empty");
const formPanel = $("form-panel");
const form = $("snippet-form");
const formTitle = $("form-title");
const formError = $("form-error");
const pickHint = $("pick-hint");
const maintenanceMsg = $("maintenance-msg");

let snippets = [];
let meta = {};

/* ------------------------------ liste ------------------------------ */

const STATUS_LABELS = {
  ok: "Up to date",
  capturing: "Capturing…",
  session_expired: "Session expired",
  selector_not_found: "Selector not found",
  error: "Error",
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

function makeBtn(label, className, onClick) {
  const btn = el("button", className || "btn", label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

function renderList() {
  listEl.replaceChildren();
  listEmptyEl.hidden = snippets.length > 0;

  for (const snippet of snippets) {
    const entry = meta[snippet.id] || null;
    const li = el("li", `snippet${snippet.enabled ? "" : " disabled"}`);

    const main = el("div", "snippet-main");
    const nameRow = el("div", "snippet-name");
    nameRow.appendChild(el("span", `dot ${stalenessClass(snippet, entry)}`));
    nameRow.appendChild(el("span", null, snippet.name));
    nameRow.appendChild(el("span", "muted", `· ${snippet.mode} · ${snippet.intervalMinutes} min`));
    main.appendChild(nameRow);
    main.appendChild(el("div", "snippet-url", snippet.url));

    const status = (entry && entry.status) || "never";
    const label = STATUS_LABELS[status] || "Never captured";
    const isBad = status !== "ok" && status !== "capturing";
    const statusLine = el("div", `snippet-status${isBad ? " bad" : ""}`);
    statusLine.textContent = `${label} — ${relativeTime((entry && entry.capturedAt) || 0)}`;
    const tip = [entry && entry.lastError, entry && entry.lastDiag].filter(Boolean).join("\n");
    if (tip) statusLine.title = tip;
    main.appendChild(statusLine);
    if (entry && entry.lastError && isBad) {
      main.appendChild(el("div", "snippet-status bad", entry.lastError));
    }

    li.appendChild(main);
    li.appendChild(
      makeBtn(snippet.enabled ? "Pause" : "Resume", "btn", async () => {
        await upsertSnippet({ ...snippet, enabled: !snippet.enabled });
        await load();
      })
    );
    li.appendChild(
      makeBtn("Capture", "btn", async () => {
        await chrome.runtime.sendMessage({ type: "captureNow", snippetId: snippet.id });
      })
    );
    li.appendChild(makeBtn("Edit", "btn", () => openForm(snippet)));
    li.appendChild(
      makeBtn("Delete", "btn btn-danger", async () => {
        if (!confirm(`Delete “${snippet.name}”?`)) return;
        await deleteSnippet(snippet.id);
        // Sinon le blob resterait orphelin dans IndexedDB.
        await deleteImage(snippet.id).catch(() => {});
        if ($("f-id").value === snippet.id) closeForm();
        await load();
      })
    );

    listEl.appendChild(li);
  }
}

/* ----------------------------- formulaire ----------------------------- */

function currentMode() {
  const checked = form.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "viewport";
}

function syncModeBlocks() {
  const mode = currentMode();
  for (const block of form.querySelectorAll(".mode-block")) {
    block.hidden = block.dataset.mode !== mode;
  }
}

for (const radio of form.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", syncModeBlocks);
}

function openForm(snippet) {
  const s = snippet ? normalizeSnippet(snippet) : normalizeSnippet({ ...DEFAULT_SNIPPET, mode: "anchor" });
  formTitle.textContent = snippet ? `Edit “${s.name}”` : "New snippet";
  $("f-id").value = snippet ? s.id : "";
  $("f-name").value = snippet ? s.name : "";
  $("f-url").value = snippet ? s.url : "";
  $("f-selector").value = s.selector;
  $("f-rect-x").value = s.rect.x;
  $("f-rect-y").value = s.rect.y;
  $("f-rect-w").value = s.rect.width;
  $("f-rect-h").value = s.rect.height;
  $("f-wait").value = s.waitForSelector;
  $("f-expired").value = s.expiredSelector;
  $("f-delay").value = s.delayMs;
  $("f-interval").value = s.intervalMinutes;
  $("f-vw").value = s.viewportWidth;
  $("f-freeze").checked = s.freezeAnimations;
  $("f-scroll-prime").checked = s.scrollPrime;
  $("f-enabled").checked = s.enabled;
  $("f-anchor").value = s.anchorSelector;
  $("anchor-offset").textContent = s.anchorSelector
    ? `Offset: ${s.offset.dx}, ${s.offset.dy} — size ${s.offset.width}×${s.offset.height} px.`
    : "No zone drawn yet.";

  const radio = form.querySelector(`input[name="mode"][value="${s.mode}"]`);
  if (radio) radio.checked = true;
  syncModeBlocks();

  formError.hidden = true;
  formError.textContent = "";
  pickHint.textContent =
    "Opens the URL in a tab: draw a rectangle, Enter confirms, Esc cancels.";
  formPanel.hidden = false;
  formPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  $("f-name").focus();
}

function closeForm() {
  formPanel.hidden = true;
  form.reset();
  $("f-id").value = "";
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function readForm() {
  const mode = currentMode();
  const url = $("f-url").value.trim();
  if (!/^https?:\/\/\S+/i.test(url)) throw new Error("The URL must start with http:// or https://");

  const selector = $("f-selector").value.trim();
  if (mode === "selector" && !selector) throw new Error("A CSS selector is required in “CSS selector” mode.");

  const rect = {
    x: Number($("f-rect-x").value),
    y: Number($("f-rect-y").value),
    width: Number($("f-rect-w").value),
    height: Number($("f-rect-h").value),
  };
  if (mode === "rect") {
    for (const [key, value] of Object.entries(rect)) {
      if (!Number.isFinite(value)) throw new Error(`Rectangle: “${key}” must be a number.`);
    }
    if (rect.width < 1 || rect.height < 1) throw new Error("Rectangle: width and height must be ≥ 1.");
  }

  const id = $("f-id").value;
  const previous = id ? snippets.find((s) => s.id === id) || {} : {};
  if (mode === "anchor" && !$("f-anchor").value.trim()) {
    throw new Error("Draw a zone first with “Redefine zone”.");
  }

  return normalizeSnippet({
    ...previous,
    ...(id ? { id } : {}),
    name: $("f-name").value.trim() || url,
    url,
    enabled: $("f-enabled").checked,
    mode,
    selector,
    rect,
    waitForSelector: $("f-wait").value.trim(),
    expiredSelector: $("f-expired").value.trim(),
    delayMs: Number($("f-delay").value),
    intervalMinutes: Number($("f-interval").value),
    viewportWidth: Number($("f-vw").value),
    freezeAnimations: $("f-freeze").checked,
    scrollPrime: $("f-scroll-prime").checked,
    createdAt: id ? previous.createdAt : Date.now(),
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const snippet = readForm();
    await upsertSnippet(snippet);
    closeForm();
    await load();
  } catch (error) {
    showFormError(error && error.message ? error.message : String(error));
  }
});

$("form-cancel").addEventListener("click", closeForm);
$("new-snippet").addEventListener("click", () => openForm(null));
$("capture-all").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "captureAll" });
});

/* ------------------------------- picker ------------------------------- */

// L'ouverture de l'onglet et l'enregistrement du résultat sont faits par le
// service worker : cette page peut être rechargée entre-temps sans rien perdre.
$("pick-zone").addEventListener("click", async () => {
  const url = $("f-url").value.trim();
  if (!/^https?:\/\/\S+/i.test(url)) {
    showFormError("Enter a valid http(s) URL first.");
    return;
  }
  const id = $("f-id").value;
  if (!id) {
    showFormError("Save the snippet first, then redefine its zone.");
    return;
  }
  formError.hidden = true;
  pickHint.textContent = "Opening the page…";

  try {
    const res = await chrome.runtime.sendMessage({ type: "startPicker", url, snippetId: id });
    if (res && res.ok === false) throw new Error(res.error || "Could not open the picker.");
    pickHint.textContent = "Draw the rectangle in the tab that opened (Esc to cancel).";
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    pickHint.textContent =
      "Opens the URL in a tab: draw a rectangle, Enter confirms, Esc cancels.";
    showFormError(
      `Could not inject the picker: ${message}. ` +
        "chrome:// pages, the Chrome Web Store and PDFs are out of reach for extensions."
    );
  }
});

/* ------------------------------ réglages ------------------------------ */

async function loadSettingsForm() {
  const settings = await getSettings();
  $("s-vw").value = settings.viewportWidth;
  $("s-vh").value = settings.viewportHeight;
  $("s-tick").value = settings.tickMinutes;
  $("s-wait-timeout").value = settings.waitSelectorTimeoutMs;
  $("s-images-timeout").value = settings.imagesTimeoutMs;
  $("s-capture-window").checked = settings.captureWindow;
}

$("save-settings").addEventListener("click", async () => {
  await setSettings({
    viewportWidth: Number($("s-vw").value),
    viewportHeight: Number($("s-vh").value),
    tickMinutes: Number($("s-tick").value),
    waitSelectorTimeoutMs: Number($("s-wait-timeout").value),
    imagesTimeoutMs: Number($("s-images-timeout").value),
    captureWindow: $("s-capture-window").checked,
  });
  await loadSettingsForm();
  const flag = $("settings-saved");
  flag.hidden = false;
  setTimeout(() => {
    flag.hidden = true;
  }, 2000);
});

/* ----------------------------- maintenance ----------------------------- */

function showMaintenance(message) {
  maintenanceMsg.textContent = message;
  maintenanceMsg.hidden = false;
}

$("clear-images").addEventListener("click", async () => {
  if (!confirm("Delete all captured images? Your configuration is kept.")) return;
  await clearImages();
  const nextMeta = {};
  for (const [id, entry] of Object.entries(meta)) {
    nextMeta[id] = { ...entry, capturedAt: 0, width: 0, height: 0, status: "never" };
  }
  await chrome.storage.local.set({ [KEY_META]: nextMeta });
  await load();
  showMaintenance("Images deleted.");
});

$("export-config").addEventListener("click", async () => {
  const [list, settings] = await Promise.all([getSnippets(), getSettings()]);
  const payload = { version: 2, exportedAt: new Date().toISOString(), snippets: list, settings };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `local-live-snippets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showMaintenance("Configuration exported (images not included).");
});

$("import-config").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !Array.isArray(payload.snippets)) {
      throw new Error("Invalid file: missing “snippets” field.");
    }
    if (!confirm(`Replace the current configuration with ${payload.snippets.length} snippet(s)?`)) return;
    // Les exports v1 (displayWidth, gridColumns, sans layout) restent lisibles :
    // les champs disparus sont ignorés et la grille replace les cartes.
    const legacy = Number(payload.version) < 2;
    await setSnippets(payload.snippets);
    if (payload.settings) await setSettings(payload.settings);
    await load();
    await loadSettingsForm();
    showMaintenance(
      legacy
        ? `${payload.snippets.length} snippet(s) imported from a v1 export: cards will be repositioned automatically.`
        : `${payload.snippets.length} snippet(s) imported.`
    );
  } catch (error) {
    showMaintenance(`Import failed: ${error && error.message ? error.message : String(error)}`);
  }
});

/* -------------------------------- boot -------------------------------- */

async function load() {
  [snippets, meta] = await Promise.all([getSnippets(), getMeta()]);
  renderList();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.meta || changes.snippets) load().catch((error) => console.warn("[LLS] options load", error));
});

syncModeBlocks();
await load();
await loadSettingsForm();
