// Page Nouvel Onglet : lit IndexedDB + meta instantanément, puis demande au SW
// de rafraîchir ce qui est périmé. Aucun accès réseau depuis cette page.
// Les cartes sont posées librement sur une grille à 12 colonnes (drag + resize).

import { deleteImage, getAllImages, getImage } from "./db.js";
import {
  GRID_COLUMNS,
  GRID_GAP,
  deleteSnippet,
  fitsInGrid,
  findFreeSlot,
  getMeta,
  getSnippets,
  layoutSizeForImage,
  upsertSnippet,
} from "./storage.js";

const grid = document.getElementById("grid");
const ghost = document.getElementById("ghost");
const emptyBox = document.getElementById("empty");
const clockEl = document.getElementById("clock");
const runStatusEl = document.getElementById("run-status");

/** id -> { card, head, dot, title, age, refreshBtn, menuBtn, fitBtn, body, handle,
 *          objectUrl, snippet, metaEntry, image } */
const cards = new Map();
let snippets = [];
let meta = {};
/** Drag/resize en cours : le re-rendu sur storage.onChanged est mis en attente. */
let interacting = null;
let pendingReload = false;
/** Menu « ⋯ » ouvert, s'il y en a un. */
let openMenu = null;

function relativeTime(timestamp) {
  if (!timestamp) return "jamais capturé";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

function stalenessClass(snippet, metaEntry) {
  const status = metaEntry && metaEntry.status;
  if (status && status !== "ok" && status !== "capturing") return "error";
  const capturedAt = (metaEntry && metaEntry.capturedAt) || 0;
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

function openUrl(url) {
  if (!url) return;
  chrome.tabs.create({ url, active: true });
}

async function captureNow(snippetId) {
  try {
    await chrome.runtime.sendMessage({ type: "captureNow", snippetId });
  } catch (error) {
    console.warn("[LLS] captureNow", error);
  }
}

/* ------------------------------ géométrie ------------------------------ */

/** Largeur d'une colonne (gaps compris) pour la largeur courante du conteneur. */
function cellSize() {
  const total = grid.clientWidth || 1200;
  return (total - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
}

function layoutToPixels(layout) {
  const cell = cellSize();
  return {
    left: layout.col * (cell + GRID_GAP),
    top: layout.row * (cell + GRID_GAP),
    width: layout.w * cell + (layout.w - 1) * GRID_GAP,
    height: layout.h * cell + (layout.h - 1) * GRID_GAP,
  };
}

/** Convertit une position/taille en pixels vers les unités de grille les plus proches. */
function pixelsToLayout(px) {
  const cell = cellSize();
  const step = cell + GRID_GAP;
  const w = Math.min(GRID_COLUMNS, Math.max(2, Math.round((px.width + GRID_GAP) / step)));
  const h = Math.max(1, Math.round((px.height + GRID_GAP) / step));
  const col = Math.min(GRID_COLUMNS - w, Math.max(0, Math.round(px.left / step)));
  const row = Math.max(0, Math.round(px.top / step));
  return { col, row, w, h };
}

/** Layouts occupés, sauf celui du snippet en cours de manipulation. */
function takenLayouts(exceptId) {
  return snippets
    .filter((s) => s.id !== exceptId && s.layout)
    .map((s) => s.layout);
}

function applyLayout(entry) {
  const layout = entry.snippet.layout;
  if (!layout) return;
  const px = layoutToPixels(layout);
  entry.card.style.left = `${px.left}px`;
  entry.card.style.top = `${px.top}px`;
  entry.card.style.width = `${px.width}px`;
  entry.card.style.height = `${px.height}px`;
}

function updateGridHeight() {
  const rows = snippets.reduce((acc, s) => (s.layout ? Math.max(acc, s.layout.row + s.layout.h) : acc), 0);
  const cell = cellSize();
  grid.style.height = rows ? `${rows * cell + (rows - 1) * GRID_GAP}px` : "0px";
}

function applyAllLayouts() {
  for (const entry of cards.values()) applyLayout(entry);
  updateGridHeight();
}

/** Attribue un layout aux snippets qui n'en ont pas et le persiste. */
async function assignMissingLayouts(images) {
  const toSave = [];
  for (const snippet of snippets) {
    if (snippet.layout) continue;
    const size = layoutSizeForImage(images ? images.get(snippet.id) : null);
    snippet.layout = findFreeSlot(size.w, size.h, takenLayouts(snippet.id));
    toSave.push(snippet);
  }
  for (const snippet of toSave) {
    await upsertSnippet(snippet).catch((error) => console.warn("[LLS] layout initial", error));
  }
}

/* -------------------------------- cartes -------------------------------- */

function buildNotice(snippet, metaEntry, status, hasImage) {
  const lastError = (metaEntry && metaEntry.lastError) || "";

  if (status === "session_expired") {
    const box = el("div", `notice bad${hasImage ? " on-image" : ""}`);
    box.appendChild(el("strong", null, "Session expirée"));
    box.appendChild(
      el("span", null, hasImage ? "Image conservée, non mise à jour." : "Aucune image disponible.")
    );
    const btn = el("button", "btn", "Ouvrir le site pour se reconnecter");
    btn.type = "button";
    btn.addEventListener("click", () => openUrl(snippet.url));
    box.appendChild(btn);
    return box;
  }

  if (status === "selector_not_found") {
    const box = el("div", `notice bad${hasImage ? " on-image" : ""}`);
    box.appendChild(el("strong", null, "Sélecteur introuvable"));
    box.appendChild(el("span", "err-detail", snippet.selector || snippet.anchorSelector || lastError));
    return box;
  }

  if (status === "error") {
    const box = el("div", `notice bad${hasImage ? " on-image" : ""}`);
    box.appendChild(el("strong", null, "Erreur de capture"));
    if (lastError) box.appendChild(el("span", "err-detail", lastError));
    return box;
  }

  if (!hasImage && status !== "capturing") {
    const box = el("div", "notice");
    box.appendChild(el("strong", null, "Jamais capturé"));
    box.appendChild(el("span", null, "La première capture partira au prochain rafraîchissement."));
    const btn = el("button", "btn", "Capturer maintenant");
    btn.type = "button";
    btn.addEventListener("click", () => captureNow(snippet.id));
    box.appendChild(btn);
    return box;
  }

  if (!snippet.enabled) {
    const box = el("div", `notice${hasImage ? " on-image" : ""}`);
    box.appendChild(el("strong", null, "Désactivé"));
    box.appendChild(el("span", null, "Ce snippet n'est plus rafraîchi automatiquement."));
    return box;
  }

  return null;
}

/** Construit (ou reconstruit) le contenu d'une carte. */
function renderCard(entry) {
  const { snippet, metaEntry, image } = entry;
  const status = (metaEntry && metaEntry.status) || (image ? "ok" : "never");
  const capturedAt = (image && image.capturedAt) || (metaEntry && metaEntry.capturedAt) || 0;

  entry.dot.className = `dot ${stalenessClass(snippet, metaEntry)}`;
  entry.title.textContent = snippet.name;
  entry.title.title = snippet.url;
  entry.age.textContent = relativeTime(capturedAt);

  const busy = status === "capturing" || (metaEntry && metaEntry.queued);
  entry.refreshBtn.disabled = Boolean(busy);
  entry.refreshBtn.textContent = busy ? "…" : "↻";
  entry.refreshBtn.title = busy ? "Capture en cours…" : "Capturer maintenant";

  entry.body.className = `card-body${snippet.fit === "cover" ? " fit-cover" : ""}`;
  entry.fitBtn.title =
    snippet.fit === "cover" ? "Afficher l'image entière (contain)" : "Remplir la carte (cover)";

  entry.body.replaceChildren();

  if (image && image.blob) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = URL.createObjectURL(image.blob);
    const img = el("img");
    img.src = entry.objectUrl;
    img.alt = snippet.name;
    img.title = `Ouvrir ${snippet.url}`;
    img.draggable = false;
    img.addEventListener("click", () => {
      // Après un glisser, le clic de fin ne doit pas ouvrir l'URL.
      if (entry.suppressClick) {
        entry.suppressClick = false;
        return;
      }
      openUrl(snippet.url);
    });
    entry.body.appendChild(img);
  }

  if (status === "capturing") {
    entry.body.appendChild(el("span", "capturing", "Capture en cours…"));
  }

  if (status === "ok" && metaEntry && metaEntry.warning) {
    const badge = el("span", "warning-badge", metaEntry.warning);
    badge.title = [metaEntry.warning, metaEntry.lastDiag].filter(Boolean).join("\n");
    entry.body.appendChild(badge);
  }

  // Rendu jugé vide : la piste la plus efficace est la fenêtre de capture dédiée.
  if (status === "ok" && metaEntry && metaEntry.blankSuspected) {
    const box = el("div", "blank-hint");
    const badge = el("span", "blank-badge", "⚠ Rendu probablement vide");
    badge.title = [
      "La page a sans doute été rendue sans jamais être peinte (onglet en arrière-plan).",
      metaEntry.lastDiag,
    ]
      .filter(Boolean)
      .join("\n");
    box.appendChild(badge);
    const link = el("button", "blank-link", "Activer la fenêtre de capture dédiée");
    link.type = "button";
    link.title = "Ouvre les Paramètres, section « Réglages globaux »";
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      chrome.runtime.openOptionsPage();
    });
    box.appendChild(link);
    entry.body.appendChild(box);
  }

  const notice = buildNotice(snippet, metaEntry, status, Boolean(image && image.blob));
  if (notice) entry.body.appendChild(notice);
}

/* -------------------------------- menu ⋯ -------------------------------- */

function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
}

function menuItem(label, onClick, className) {
  const btn = el("button", className, label);
  btn.type = "button";
  btn.addEventListener("click", () => {
    closeMenu();
    onClick();
  });
  return btn;
}

async function redefineZone(snippet) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "startPicker",
      url: snippet.url,
      snippetId: snippet.id,
    });
    if (res && res.ok === false) window.alert(res.error || "Impossible d'ouvrir le sélecteur.");
  } catch (error) {
    window.alert(`Impossible d'ouvrir le sélecteur : ${error && error.message ? error.message : error}`);
  }
}

function openCardMenu(entry) {
  closeMenu();
  const snippet = entry.snippet;
  const menu = el("div", "card-menu");

  menu.appendChild(menuItem("Redéfinir la zone", () => redefineZone(snippet)));

  menu.appendChild(
    menuItem("Renommer", async () => {
      const name = window.prompt("Nom du snippet", snippet.name);
      if (name === null) return;
      await upsertSnippet({ ...snippet, name: name.trim() || snippet.name });
    })
  );

  menu.appendChild(
    menuItem("Intervalle", async () => {
      const raw = window.prompt("Intervalle de capture (minutes)", String(snippet.intervalMinutes));
      if (raw === null) return;
      const minutes = Number(raw);
      if (!Number.isFinite(minutes) || minutes < 1) {
        window.alert("Intervalle invalide : indiquez un nombre de minutes ≥ 1.");
        return;
      }
      await upsertSnippet({ ...snippet, intervalMinutes: Math.round(minutes) });
    })
  );

  menu.appendChild(
    menuItem(
      "Supprimer",
      async () => {
        if (!window.confirm(`Supprimer « ${snippet.name} » ? L'image capturée sera effacée.`)) return;
        await deleteImage(snippet.id).catch((error) => console.warn("[LLS] deleteImage", error));
        await deleteSnippet(snippet.id);
      },
      "danger"
    )
  );

  entry.card.appendChild(menu);
  openMenu = menu;
}

document.addEventListener("click", (event) => {
  if (!openMenu) return;
  if (openMenu.contains(event.target)) return;
  if (event.target.closest && event.target.closest(".card-menu-btn")) return;
  closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

/* --------------------------- drag et resize --------------------------- */

const MOVE_THRESHOLD = 4;

function beginInteraction(entry, kind, event) {
  if (event.button !== 0) return;
  closeMenu();
  event.preventDefault();

  const px = layoutToPixels(entry.snippet.layout);
  interacting = {
    entry,
    kind,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startPx: px,
    currentPx: { ...px },
    moved: false,
  };

  const target = event.currentTarget;
  try {
    target.setPointerCapture(event.pointerId);
  } catch (_) {
    /* les listeners document assurent le suivi */
  }
  entry.card.classList.add("dragging");
}

function onPointerMove(event) {
  if (!interacting || event.pointerId !== interacting.pointerId) return;
  const dx = event.clientX - interacting.startX;
  const dy = event.clientY - interacting.startY;
  if (!interacting.moved && Math.abs(dx) + Math.abs(dy) < MOVE_THRESHOLD) return;
  interacting.moved = true;

  const { entry, kind, startPx } = interacting;
  const cell = cellSize();
  const px =
    kind === "move"
      ? { ...startPx, left: startPx.left + dx, top: Math.max(0, startPx.top + dy) }
      : {
          ...startPx,
          width: Math.max(2 * cell, startPx.width + dx),
          height: Math.max(cell, startPx.height + dy),
        };
  interacting.currentPx = px;

  entry.card.style.left = `${px.left}px`;
  entry.card.style.top = `${px.top}px`;
  entry.card.style.width = `${px.width}px`;
  entry.card.style.height = `${px.height}px`;

  // Fantôme : position snappée que l'on obtiendra au relâchement.
  const snapped = pixelsToLayout(px);
  interacting.snapped = snapped;
  const ghostPx = layoutToPixels(snapped);
  ghost.hidden = false;
  ghost.style.left = `${ghostPx.left}px`;
  ghost.style.top = `${ghostPx.top}px`;
  ghost.style.width = `${ghostPx.width}px`;
  ghost.style.height = `${ghostPx.height}px`;
}

async function onPointerUp(event) {
  if (!interacting || event.pointerId !== interacting.pointerId) return;
  const { entry, moved, snapped } = interacting;
  interacting = null;
  ghost.hidden = true;
  entry.card.classList.remove("dragging");

  if (!moved || !snapped) {
    applyLayout(entry);
    await flushPendingReload();
    return;
  }

  // Un glisser ne doit pas se terminer par l'ouverture de l'URL.
  entry.suppressClick = true;
  setTimeout(() => {
    entry.suppressClick = false;
  }, 300);

  if (fitsInGrid(snapped, takenLayouts(entry.snippet.id))) {
    entry.snippet = { ...entry.snippet, layout: snapped };
    const index = snippets.findIndex((s) => s.id === entry.snippet.id);
    if (index >= 0) snippets[index] = entry.snippet;
    applyLayout(entry);
    updateGridHeight();
    await upsertSnippet(entry.snippet).catch((error) => console.warn("[LLS] layout", error));
  } else {
    // Chevauchement : on refuse et on remet la carte où elle était.
    applyLayout(entry);
  }
  await flushPendingReload();
}

document.addEventListener("pointermove", onPointerMove);
document.addEventListener("pointerup", (event) => {
  onPointerUp(event).catch((error) => console.warn("[LLS] pointerup", error));
});
document.addEventListener("pointercancel", (event) => {
  onPointerUp(event).catch((error) => console.warn("[LLS] pointercancel", error));
});

async function flushPendingReload() {
  if (!pendingReload) return;
  pendingReload = false;
  await load().catch((error) => console.warn("[LLS] reload différé", error));
}

/* ----------------------------- construction ----------------------------- */

function createCard(snippet) {
  const card = el("article", "card");

  const head = el("div", "card-head");
  const dot = el("span", "dot");
  const title = el("span", "card-title");
  const age = el("span", "card-age");

  const fitBtn = el("button", "icon-btn", "⤢");
  fitBtn.type = "button";

  const refreshBtn = el("button", "icon-btn", "↻");
  refreshBtn.type = "button";
  refreshBtn.addEventListener("click", () => captureNow(snippet.id));

  const menuBtn = el("button", "icon-btn card-menu-btn", "⋯");
  menuBtn.type = "button";
  menuBtn.title = "Plus d'actions";

  head.append(dot, title, age, fitBtn, refreshBtn, menuBtn);

  const body = el("div", "card-body");
  const handle = el("div", "resize-handle");
  handle.title = "Redimensionner";
  card.append(head, body, handle);

  const entry = {
    card,
    head,
    dot,
    title,
    age,
    fitBtn,
    refreshBtn,
    menuBtn,
    body,
    handle,
    objectUrl: null,
    suppressClick: false,
    snippet,
  };

  fitBtn.addEventListener("click", async () => {
    const fit = entry.snippet.fit === "cover" ? "contain" : "cover";
    await upsertSnippet({ ...entry.snippet, fit });
  });
  menuBtn.addEventListener("click", () => {
    if (openMenu && entry.card.contains(openMenu)) closeMenu();
    else openCardMenu(entry);
  });

  // Les boutons de l'en-tête ne doivent pas démarrer un glisser.
  head.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    beginInteraction(entry, "move", event);
  });
  handle.addEventListener("pointerdown", (event) => beginInteraction(entry, "resize", event));

  return entry;
}

/** Rendu complet de la grille. */
function renderAll(images) {
  const seen = new Set();
  for (const snippet of snippets) {
    seen.add(snippet.id);
    let entry = cards.get(snippet.id);
    if (!entry) {
      entry = createCard(snippet);
      cards.set(snippet.id, entry);
      grid.appendChild(entry.card);
    }
    entry.snippet = snippet;
    entry.metaEntry = meta[snippet.id] || null;
    if (images) entry.image = images.get(snippet.id) || null;
    renderCard(entry);
    applyLayout(entry);
  }

  for (const [id, entry] of cards) {
    if (seen.has(id)) continue;
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.card.remove();
    cards.delete(id);
  }

  updateGridHeight();

  const isEmpty = snippets.length === 0;
  emptyBox.hidden = !isEmpty;
  grid.hidden = isEmpty;
}

/** Recharge l'image d'un seul snippet et rerend sa carte. */
async function refreshOneCard(id) {
  const entry = cards.get(id);
  if (!entry) return;
  entry.metaEntry = meta[id] || null;
  const image = await getImage(id);
  entry.image = image || null;
  renderCard(entry);
}

function updateAges() {
  for (const entry of cards.values()) {
    const capturedAt =
      (entry.image && entry.image.capturedAt) || (entry.metaEntry && entry.metaEntry.capturedAt) || 0;
    entry.age.textContent = relativeTime(capturedAt);
    entry.dot.className = `dot ${stalenessClass(entry.snippet, entry.metaEntry)}`;
  }
}

function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateRunStatus() {
  const busy = snippets.filter((s) => {
    const entry = meta[s.id];
    return entry && (entry.status === "capturing" || entry.queued);
  });
  if (!busy.length) {
    runStatusEl.hidden = true;
    runStatusEl.textContent = "";
    return;
  }
  runStatusEl.hidden = false;
  runStatusEl.textContent =
    busy.length === 1 ? "1 capture en cours…" : `${busy.length} captures en attente…`;
}

async function load() {
  const [loadedSnippets, loadedMeta, images] = await Promise.all([
    getSnippets(),
    getMeta(),
    getAllImages().catch((error) => {
      console.warn("[LLS] IndexedDB", error);
      return new Map();
    }),
  ]);
  snippets = loadedSnippets;
  meta = loadedMeta;
  await assignMissingLayouts(images);
  renderAll(images);
  updateRunStatus();
}

document.getElementById("refresh-all").addEventListener("click", async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "captureAll" });
  } catch (error) {
    console.warn("[LLS] captureAll", error);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
    }, 1500);
  }
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("empty-cta").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.snippets || changes.settings) {
    // Un re-rendu couperait le glisser en cours : on le repousse.
    if (interacting) {
      pendingReload = true;
      return;
    }
    load().catch((error) => console.warn("[LLS] reload", error));
    return;
  }

  if (changes.meta) {
    const before = changes.meta.oldValue || {};
    const after = changes.meta.newValue || {};
    meta = after;
    const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const id of ids) {
      if (JSON.stringify(before[id]) === JSON.stringify(after[id])) continue;
      refreshOneCard(id).catch((error) => console.warn("[LLS] refreshOneCard", error));
    }
    updateRunStatus();
  }
});

// La largeur des colonnes suit la largeur du conteneur.
new ResizeObserver(() => {
  if (interacting) return;
  applyAllLayouts();
}).observe(grid);

setInterval(updateAges, 30000);
setInterval(updateClock, 30000);
updateClock();

await load();

// Après le premier rendu seulement : le SW peut enfiler ce qui est périmé.
chrome.runtime
  .sendMessage({ type: "refreshIfStale" })
  .catch((error) => console.warn("[LLS] refreshIfStale", error));
