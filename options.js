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
  ok: "À jour",
  capturing: "Capture en cours…",
  session_expired: "Session expirée",
  selector_not_found: "Sélecteur introuvable",
  error: "Erreur",
};

function relativeTime(timestamp) {
  if (!timestamp) return "jamais capturé";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
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
    const label = STATUS_LABELS[status] || "Jamais capturé";
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
      makeBtn(snippet.enabled ? "Désactiver" : "Activer", "btn", async () => {
        await upsertSnippet({ ...snippet, enabled: !snippet.enabled });
        await load();
      })
    );
    li.appendChild(
      makeBtn("Capturer", "btn", async () => {
        await chrome.runtime.sendMessage({ type: "captureNow", snippetId: snippet.id });
      })
    );
    li.appendChild(makeBtn("Éditer", "btn", () => openForm(snippet)));
    li.appendChild(
      makeBtn("Supprimer", "btn btn-danger", async () => {
        if (!confirm(`Supprimer « ${snippet.name} » ?`)) return;
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
  formTitle.textContent = snippet ? `Éditer « ${s.name} »` : "Nouveau snippet";
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
    ? `Décalage : ${s.offset.dx}, ${s.offset.dy} — taille ${s.offset.width}×${s.offset.height} px.`
    : "Aucune zone dessinée pour l'instant.";

  const radio = form.querySelector(`input[name="mode"][value="${s.mode}"]`);
  if (radio) radio.checked = true;
  syncModeBlocks();

  formError.hidden = true;
  formError.textContent = "";
  pickHint.textContent =
    "Ouvre l'URL dans un onglet : dessinez un rectangle, Entrée valide, Échap annule.";
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
  if (!/^https?:\/\/\S+/i.test(url)) throw new Error("L'URL doit commencer par http:// ou https://");

  const selector = $("f-selector").value.trim();
  if (mode === "selector" && !selector) throw new Error("Un sélecteur CSS est requis en mode « Sélecteur ».");

  const rect = {
    x: Number($("f-rect-x").value),
    y: Number($("f-rect-y").value),
    width: Number($("f-rect-w").value),
    height: Number($("f-rect-h").value),
  };
  if (mode === "rect") {
    for (const [key, value] of Object.entries(rect)) {
      if (!Number.isFinite(value)) throw new Error(`Rectangle : « ${key} » doit être un nombre.`);
    }
    if (rect.width < 1 || rect.height < 1) throw new Error("Rectangle : largeur et hauteur doivent être ≥ 1.");
  }

  const id = $("f-id").value;
  const previous = id ? snippets.find((s) => s.id === id) || {} : {};
  if (mode === "anchor" && !$("f-anchor").value.trim()) {
    throw new Error("Dessinez d'abord une zone avec « Redéfinir la zone ».");
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
    showFormError("Renseignez d'abord une URL http(s) valide.");
    return;
  }
  const id = $("f-id").value;
  if (!id) {
    showFormError("Enregistrez d'abord le snippet, puis redéfinissez sa zone.");
    return;
  }
  formError.hidden = true;
  pickHint.textContent = "Ouverture de la page…";

  try {
    const res = await chrome.runtime.sendMessage({ type: "startPicker", url, snippetId: id });
    if (res && res.ok === false) throw new Error(res.error || "Échec de l'ouverture du sélecteur.");
    pickHint.textContent = "Dessinez le rectangle dans l'onglet ouvert (Échap pour annuler).";
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    pickHint.textContent =
      "Ouvre l'URL dans un onglet : dessinez un rectangle, Entrée valide, Échap annule.";
    showFormError(
      `Impossible d'injecter le sélecteur : ${message}. ` +
        "Les pages chrome://, le Chrome Web Store et les PDF sont hors de portée des extensions."
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
  if (!confirm("Supprimer toutes les images capturées ? La configuration est conservée.")) return;
  await clearImages();
  const nextMeta = {};
  for (const [id, entry] of Object.entries(meta)) {
    nextMeta[id] = { ...entry, capturedAt: 0, width: 0, height: 0, status: "never" };
  }
  await chrome.storage.local.set({ [KEY_META]: nextMeta });
  await load();
  showMaintenance("Images supprimées.");
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
  showMaintenance("Configuration exportée (sans les images).");
});

$("import-config").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !Array.isArray(payload.snippets)) {
      throw new Error("Fichier invalide : champ « snippets » absent.");
    }
    if (!confirm(`Remplacer la configuration actuelle par ${payload.snippets.length} snippet(s) ?`)) return;
    // Les exports v1 (displayWidth, gridColumns, sans layout) restent lisibles :
    // les champs disparus sont ignorés et la grille replace les cartes.
    const legacy = Number(payload.version) < 2;
    await setSnippets(payload.snippets);
    if (payload.settings) await setSettings(payload.settings);
    await load();
    await loadSettingsForm();
    showMaintenance(
      legacy
        ? `${payload.snippets.length} snippet(s) importé(s) depuis un export v1 : les cartes seront replacées automatiquement.`
        : `${payload.snippets.length} snippet(s) importé(s).`
    );
  } catch (error) {
    showMaintenance(`Import échoué : ${error && error.message ? error.message : String(error)}`);
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
