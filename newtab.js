// Page Nouvel Onglet : lit IndexedDB + meta instantanément, puis demande au SW
// de rafraîchir ce qui est périmé. Aucun accès réseau depuis cette page.
// Les cartes sont posées librement (drag + resize homothétique) avec snapping
// sur les bords des autres cartes. Les positions sont stockées dans une largeur
// de référence et mises à l'échelle selon la largeur de la fenêtre.

import { deleteImage, getAllImages, getImage } from "./db.js";
import {
  BOARD_NAME_MAX,
  LAYOUT_DEFAULT_WIDTH,
  LAYOUT_GAP,
  LAYOUT_MAX_WIDTH,
  LAYOUT_MIN_WIDTH,
  aspectOf,
  boxOf,
  createBoard,
  deleteBoard,
  deleteSnippet,
  findFreeSpot,
  getBoards,
  getMeta,
  getSnippetsForBoard,
  renameBoard,
  resolveNewTabBoardId,
  setSettings,
  upsertSnippet,
} from "./storage.js";

const board = document.getElementById("board");
const guideX = document.getElementById("guide-x");
const guideY = document.getElementById("guide-y");
const emptyBox = document.getElementById("empty");
const emptyTitle = document.getElementById("empty-title");
const clockEl = document.getElementById("clock");
const runStatusEl = document.getElementById("run-status");
const boardBtn = document.getElementById("board-btn");
const boardBtnName = document.getElementById("board-btn-name");
const boardPicker = boardBtn.parentElement;

/** id -> { card, img, pill, pillDot, pillHost, foot, name, age, refreshBtn, menuBtn,
 *          handle, objectUrl, snippet, metaEntry, image, aspect } */
const cards = new Map();
let snippets = [];
let meta = {};
/** Board affiché par cette page (jamais vide après resolveBoard()). */
let currentBoardId = null;
/** Liste des boards, tenue à jour par storage.onChanged. */
let boards = [];
/** Id du board désigné New Tab (settings.newTabBoardId, résolu). */
let newTabBoardId = null;
/** Drag/resize en cours : le re-rendu sur storage.onChanged est mis en attente. */
let interacting = null;
let pendingReload = false;
/** Menu « ⋯ » ouvert, s'il y en a un. */
let openMenu = null;
/** Menu du sélecteur de board ouvert, s'il y en a un. */
let openBoardMenu = null;

const SNAP_PX = 8;
const MOVE_THRESHOLD = 4;

function relativeTime(timestamp) {
  if (!timestamp) return "never captured";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return url;
  }
}

/** Favicon du site via le cache de Chrome (permission "favicon", aucun réseau). */
function faviconOf(url) {
  const api = new URL(chrome.runtime.getURL("/_favicon/"));
  api.searchParams.set("pageUrl", url);
  api.searchParams.set("size", "32");
  return api.toString();
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

function entryBox(entry) {
  return boxOf(entry.snippet.layout, entry.aspect);
}

/** Boîtes occupées, sauf celle du snippet en cours de manipulation. */
function takenBoxes(exceptId) {
  const out = [];
  for (const entry of cards.values()) {
    if (entry.snippet.id === exceptId || !entry.snippet.layout) continue;
    out.push(entryBox(entry));
  }
  return out;
}

function placeCard(entry, box) {
  entry.card.style.left = `${Math.round(box.x)}px`;
  entry.card.style.top = `${Math.round(box.y)}px`;
  entry.card.style.width = `${Math.round(box.w)}px`;
  entry.card.style.height = `${Math.round(box.h)}px`;
}

function applyLayout(entry) {
  if (!entry.snippet.layout) return;
  placeCard(entry, entryBox(entry));
}

function updateBoardHeight() {
  let bottom = 0;
  for (const entry of cards.values()) {
    if (!entry.snippet.layout) continue;
    const b = entryBox(entry);
    bottom = Math.max(bottom, b.y + b.h);
  }
  board.style.height = `${Math.ceil(bottom + 48)}px`;
}

function applyAllLayouts() {
  for (const entry of cards.values()) applyLayout(entry);
  updateBoardHeight();
}

/** Attribue un layout aux snippets qui n'en ont pas et le persiste. */
async function assignMissingLayouts(images) {
  const taken = snippets.filter((s) => s.layout).map((s) => boxOf(s.layout, aspectOf(images.get(s.id))));
  const toSave = [];
  const maxW = board.clientWidth || 1400;
  for (const snippet of snippets) {
    if (snippet.layout) continue;
    const aspect = aspectOf(images.get(snippet.id));
    const w = LAYOUT_DEFAULT_WIDTH;
    snippet.layout = findFreeSpot(w, Math.round(w * aspect), taken, maxW);
    taken.push(boxOf(snippet.layout, aspect));
    toSave.push(snippet);
  }
  for (const snippet of toSave) {
    await upsertSnippet(snippet).catch((error) => console.warn("[LLS] initial layout", error));
  }
}

/* ------------------------------- snapping ------------------------------- */

/**
 * Snappe une boîte (pixels réels) sur les bords des autres boîtes et
 * du plateau. `mode` = "move" (x et y libres) ou "resize" (coin bas-droit).
 * Renvoie la boîte ajustée et les coordonnées des guides (ou null).
 */
function snapBox(box, taken, mode) {
  const tol = SNAP_PX;
  const boardWidth = board.clientWidth || 1600;
  const xTargets = [0, boardWidth];
  const yTargets = [0];
  for (const b of taken) {
    xTargets.push(b.x, b.x + b.w, b.x + b.w + LAYOUT_GAP, b.x - LAYOUT_GAP);
    yTargets.push(b.y, b.y + b.h, b.y + b.h + LAYOUT_GAP, b.y - LAYOUT_GAP);
  }

  const out = { ...box };
  let guideXPos = null;
  let guideYPos = null;

  if (mode === "move") {
    let best = { d: tol, dx: 0, at: null };
    for (const t of xTargets) {
      for (const edge of [box.x, box.x + box.w]) {
        const d = Math.abs(t - edge);
        if (d < best.d) best = { d, dx: t - edge, at: t };
      }
    }
    out.x += best.dx;
    guideXPos = best.at;

    best = { d: tol, dy: 0, at: null };
    for (const t of yTargets) {
      for (const edge of [box.y, box.y + box.h]) {
        const d = Math.abs(t - edge);
        if (d < best.d) best = { d, dy: t - edge, at: t };
      }
    }
    out.y += best.dy;
    guideYPos = best.at;
  } else {
    // Resize homothétique : on snappe le bord droit (largeur), ou à défaut le
    // bord bas, et on recalcule l'autre dimension.
    const aspect = box.h / box.w;
    let best = { d: tol, w: box.w, at: null, axis: null };
    for (const t of xTargets) {
      const d = Math.abs(t - (box.x + box.w));
      if (d < best.d) best = { d, w: t - box.x, at: t, axis: "x" };
    }
    for (const t of yTargets) {
      const d = Math.abs(t - (box.y + box.h));
      if (d < best.d) best = { d, w: (t - box.y) / aspect, at: t, axis: "y" };
    }
    if (best.axis && best.w >= LAYOUT_MIN_WIDTH) {
      out.w = Math.round(best.w);
      out.h = Math.round(out.w * aspect);
      if (best.axis === "x") guideXPos = best.at;
      else guideYPos = best.at;
    }
  }

  return { box: out, guideX: guideXPos, guideY: guideYPos };
}

function showGuides(gx, gy) {
  guideX.hidden = gx === null;
  guideY.hidden = gy === null;
  if (gx !== null) guideX.style.left = `${Math.round(gx)}px`;
  if (gy !== null) guideY.style.top = `${Math.round(gy)}px`;
}

function hideGuides() {
  guideX.hidden = true;
  guideY.hidden = true;
}

/* -------------------------------- cartes -------------------------------- */

function buildNotice(snippet, metaEntry, status, hasImage) {
  const lastError = (metaEntry && metaEntry.lastError) || "";

  if (status === "session_expired") {
    const box = el("div", "notice bad");
    box.appendChild(el("strong", null, "Session expired"));
    box.appendChild(el("span", null, hasImage ? "Last good image kept." : "No image yet."));
    const btn = el("button", "btn btn-small", "Open site to sign in");
    btn.type = "button";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openUrl(snippet.url);
    });
    box.appendChild(btn);
    return box;
  }

  if (status === "selector_not_found") {
    const box = el("div", "notice bad");
    box.appendChild(el("strong", null, "Selector not found"));
    box.appendChild(el("span", "err-detail", snippet.selector || snippet.anchorSelector || lastError));
    return box;
  }

  if (status === "error") {
    const box = el("div", "notice bad");
    box.appendChild(el("strong", null, "Capture failed"));
    if (lastError) box.appendChild(el("span", "err-detail", lastError));
    return box;
  }

  if (!hasImage && status !== "capturing") {
    const box = el("div", "notice");
    box.appendChild(el("strong", null, "Not captured yet"));
    const btn = el("button", "btn btn-small", "Capture now");
    btn.type = "button";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      captureNow(snippet.id);
    });
    box.appendChild(btn);
    return box;
  }

  if (!snippet.enabled) {
    const box = el("div", "notice");
    box.appendChild(el("strong", null, "Paused"));
    box.appendChild(el("span", null, "No automatic refresh."));
    return box;
  }

  return null;
}

/** Construit (ou reconstruit) le contenu d'une carte. */
function renderCard(entry) {
  const { snippet, metaEntry, image } = entry;
  const status = (metaEntry && metaEntry.status) || (image ? "ok" : "never");
  const capturedAt = (image && image.capturedAt) || (metaEntry && metaEntry.capturedAt) || 0;
  const tone = stalenessClass(snippet, metaEntry);

  entry.card.dataset.tone = tone;
  entry.pillHost.textContent = hostOf(snippet.url);
  entry.pill.title = snippet.url;
  const iconSrc = faviconOf(snippet.url);
  if (entry.pillIcon.getAttribute("src") !== iconSrc) {
    entry.pill.classList.remove("no-icon");
    entry.pillIcon.src = iconSrc;
  }
  entry.name.textContent = snippet.name;
  entry.age.textContent = relativeTime(capturedAt);

  const busy = status === "capturing" || (metaEntry && metaEntry.queued);
  entry.refreshBtn.disabled = Boolean(busy);
  entry.refreshBtn.classList.toggle("spinning", Boolean(busy));
  entry.refreshBtn.title = busy ? "Capturing…" : "Capture now";

  entry.overlay.replaceChildren();

  if (image && image.blob) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = URL.createObjectURL(image.blob);
    entry.img.src = entry.objectUrl;
    entry.img.alt = snippet.name;
    entry.img.hidden = false;
  } else {
    entry.img.removeAttribute("src");
    entry.img.hidden = true;
  }

  const badges = el("div", "badges");
  if (status === "capturing") badges.appendChild(el("span", "badge", "Capturing…"));
  if (status === "ok" && metaEntry && metaEntry.warning) {
    const badge = el("span", "badge warn", metaEntry.warning);
    badge.title = [metaEntry.warning, metaEntry.lastDiag].filter(Boolean).join("\n");
    badges.appendChild(badge);
  }
  if (status === "ok" && metaEntry && metaEntry.blankSuspected) {
    const badge = el("button", "badge warn", "Looks blank · use capture window");
    badge.type = "button";
    badge.title = [
      "The page was probably never painted (background tab). Enable the dedicated capture window in Settings.",
      metaEntry.lastDiag,
    ]
      .filter(Boolean)
      .join("\n");
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      chrome.runtime.openOptionsPage();
    });
    badges.appendChild(badge);
  }
  if (badges.childElementCount) entry.overlay.appendChild(badges);

  const notice = buildNotice(snippet, metaEntry, status, Boolean(image && image.blob));
  if (notice) entry.overlay.appendChild(notice);
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
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
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
    if (res && res.ok === false) window.alert(res.error || "Could not open the picker.");
  } catch (error) {
    window.alert(`Could not open the picker: ${error && error.message ? error.message : error}`);
  }
}

function openCardMenu(entry) {
  closeMenu();
  const snippet = entry.snippet;
  const menu = el("div", "card-menu");
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());

  menu.appendChild(menuItem("Open page", () => openUrl(snippet.url)));
  menu.appendChild(menuItem("Redefine zone", () => redefineZone(snippet)));
  menu.appendChild(
    menuItem("Rename", async () => {
      const name = window.prompt("Snippet name", snippet.name);
      if (name === null) return;
      await upsertSnippet({ ...snippet, name: name.trim() || snippet.name });
    })
  );
  menu.appendChild(
    menuItem("Interval", async () => {
      const raw = window.prompt("Capture interval (minutes)", String(snippet.intervalMinutes));
      if (raw === null) return;
      const minutes = Number(raw);
      if (!Number.isFinite(minutes) || minutes < 1) {
        window.alert("Invalid interval: enter a number of minutes ≥ 1.");
        return;
      }
      await upsertSnippet({ ...snippet, intervalMinutes: Math.round(minutes) });
    })
  );
  menu.appendChild(
    menuItem(snippet.enabled ? "Pause" : "Resume", async () => {
      await upsertSnippet({ ...snippet, enabled: !snippet.enabled });
    })
  );
  menu.appendChild(
    menuItem(
      "Delete",
      async () => {
        if (!window.confirm(`Delete “${snippet.name}”? The captured image will be erased.`)) return;
        await deleteImage(snippet.id).catch((error) => console.warn("[LLS] deleteImage", error));
        await deleteSnippet(snippet.id);
      },
      "danger"
    )
  );

  entry.card.appendChild(menu);
  entry.card.classList.add("menu-open");
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

/* ----------------------------- sélecteur de board ----------------------------- */

function currentBoard() {
  return boards.find((b) => b.id === currentBoardId) || null;
}

function currentBoardName() {
  const b = currentBoard();
  return b ? b.name : "Board";
}

/** Titre de l'onglet, libellé du bouton et texte de l'état vide. */
function applyBoardChrome() {
  const name = currentBoardName();
  document.title = `${name} — Boardmine`;
  boardBtnName.textContent = name;
  boardBtn.title = name;
  emptyTitle.textContent = `Nothing on “${name}” yet`;
}

/** Met l'URL en phase avec le board affiché, sans recharger la page. */
function syncUrl() {
  const url = new URL(location.href);
  if (url.searchParams.get("board") === currentBoardId) return;
  url.searchParams.set("board", currentBoardId);
  history.replaceState(null, "", url);
}

function closeBoardMenu() {
  if (!openBoardMenu) return;
  openBoardMenu.remove();
  openBoardMenu = null;
  boardBtn.setAttribute("aria-expanded", "false");
}

/** Bascule in-place sur un autre board (ne touche pas à newTabBoardId). */
async function switchBoard(boardId) {
  if (!boardId) return;
  currentBoardId = boardId;
  syncUrl();
  applyBoardChrome();
  renderBoardMenu();
  await load();
}

// Indicateur « affiché sur le Nouvel Onglet » : cercle vide, ou plein avec un
// point central pour le board actif (sémantique radio, un seul à la fois).
const PIN_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle class="pin-ring" cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle class="pin-dot" cx="8" cy="8" r="3" fill="currentColor"/></svg>';

// keepOpen : l'action remplace le contenu du menu au lieu de le fermer.
function boardMenuButton(label, onClick, className, keepOpen) {
  const btn = el("button", className, label);
  btn.type = "button";
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!keepOpen) closeBoardMenu();
    Promise.resolve(onClick()).catch((error) => console.warn("[LLS] board menu", error));
  });
  return btn;
}

/** Ligne « board » : nom (bascule) + épingle « New Tab ». */
function boardRow(entryBoard) {
  const row = el("div", "board-row");
  row.dataset.current = String(entryBoard.id === currentBoardId);

  const nameBtn = el("button", "board-row-name", entryBoard.name);
  nameBtn.type = "button";
  nameBtn.title = entryBoard.name;
  nameBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    closeBoardMenu();
    switchBoard(entryBoard.id).catch((error) => console.warn("[LLS] switchBoard", error));
  });

  const pin = el("button", "board-row-pin", "");
  pin.type = "button";
  pin.innerHTML = PIN_SVG;
  const pinned = entryBoard.id === newTabBoardId;
  pin.setAttribute("aria-pressed", String(pinned));
  pin.title = pinned ? "Shown on New Tab" : "Show this board on New Tab";
  pin.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await setSettings({ newTabBoardId: entryBoard.id });
      newTabBoardId = entryBoard.id;
      renderBoardMenu();
    } catch (error) {
      console.warn("[LLS] newTabBoardId", error);
    }
  });

  row.append(nameBtn);
  if (pinned) row.append(el("span", "board-row-tag", "New Tab"));
  row.append(pin);
  return row;
}

/** Saisie inline du nom d'un nouveau board, en place dans le menu. */
function showNewBoardInput(menu) {
  const input = el("input", "board-name-input");
  input.type = "text";
  input.placeholder = "Board name";
  input.maxLength = BOARD_NAME_MAX;
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", async (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      renderBoardMenu();
      return;
    }
    if (event.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return;
    closeBoardMenu();
    try {
      const created = await createBoard(name);
      boards = await getBoards();
      await switchBoard(created.id);
    } catch (error) {
      window.alert(`Could not create the board: ${error && error.message ? error.message : error}`);
    }
  });

  menu.replaceChildren(input);
  input.focus();
}

async function renameCurrentBoard() {
  const name = window.prompt("Board name", currentBoardName());
  if (name === null) return;
  const clean = name.trim();
  if (!clean) return;
  try {
    await renameBoard(currentBoardId, clean);
    boards = await getBoards();
    applyBoardChrome();
    renderBoardMenu();
  } catch (error) {
    window.alert(`Could not rename the board: ${error && error.message ? error.message : error}`);
  }
}

async function deleteCurrentBoard() {
  if (boards.length <= 1) return;
  const name = currentBoardName();
  const count = snippets.length;
  const detail =
    count === 0
      ? "It has no snippet."
      : count === 1
        ? "1 snippet and its captured image will be erased."
        : `${count} snippets and their captured images will be erased.`;
  if (!window.confirm(`Delete “${name}”? ${detail}`)) return;

  try {
    const { deletedSnippetIds } = await deleteBoard(currentBoardId);
    // La page qui supprime purge IndexedDB (comme pour deleteSnippet).
    for (const id of deletedSnippetIds) {
      await deleteImage(id).catch((error) => console.warn("[LLS] deleteImage", error));
    }
    boards = await getBoards();
    newTabBoardId = await resolveNewTabBoardId();
    await switchBoard(newTabBoardId);
  } catch (error) {
    window.alert(`Could not delete the board: ${error && error.message ? error.message : error}`);
  }
}

/** (Re)construit le menu déroulant s'il est ouvert. */
function renderBoardMenu() {
  applyBoardChrome();
  if (!openBoardMenu) return;
  const menu = openBoardMenu;
  menu.replaceChildren();

  for (const b of boards) menu.appendChild(boardRow(b));
  menu.appendChild(el("div", "board-menu-sep"));
  menu.appendChild(boardMenuButton("New board…", () => showNewBoardInput(menu), null, true));
  menu.appendChild(boardMenuButton("Rename", () => renameCurrentBoard()));

  const del = boardMenuButton("Delete", () => deleteCurrentBoard(), "danger");
  if (boards.length <= 1) {
    del.disabled = true;
    del.title = "The last board cannot be deleted.";
  }
  menu.appendChild(del);
}

function openBoardPicker() {
  closeMenu();
  closeBoardMenu();
  const menu = el("div", "board-menu");
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  boardPicker.appendChild(menu);
  openBoardMenu = menu;
  boardBtn.setAttribute("aria-expanded", "true");
  renderBoardMenu();
}

boardBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (openBoardMenu) closeBoardMenu();
  else openBoardPicker();
});

document.addEventListener("click", (event) => {
  if (!openBoardMenu) return;
  if (openBoardMenu.contains(event.target)) return;
  if (event.target.closest && event.target.closest("#board-btn")) return;
  closeBoardMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeBoardMenu();
});

/**
 * Board affiché : ?board=<id> valide, sinon le board du Nouvel Onglet.
 * Un ?board= inconnu est ignoré et retiré de l'URL.
 */
async function resolveBoard() {
  boards = await getBoards();
  newTabBoardId = await resolveNewTabBoardId();

  const url = new URL(location.href);
  const wanted = url.searchParams.get("board");
  if (wanted && boards.some((b) => b.id === wanted)) {
    currentBoardId = wanted;
  } else {
    currentBoardId = newTabBoardId;
    if (wanted !== null) {
      url.searchParams.delete("board");
      history.replaceState(null, "", url);
    }
  }
  applyBoardChrome();
}

/* --------------------------- drag et resize --------------------------- */

function beginInteraction(entry, kind, event) {
  if (event.button !== 0) return;
  if (!entry.snippet.layout) return;
  closeMenu();
  event.preventDefault();

  const box = entryBox(entry);
  interacting = {
    entry,
    kind,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startBox: box,
    result: null,
    moved: false,
  };

  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch (_) {
    /* les listeners document assurent le suivi */
  }
}

function onPointerMove(event) {
  if (!interacting || event.pointerId !== interacting.pointerId) return;
  const dx = event.clientX - interacting.startX;
  const dy = event.clientY - interacting.startY;
  if (!interacting.moved) {
    if (Math.abs(dx) + Math.abs(dy) < MOVE_THRESHOLD) return;
    interacting.moved = true;
    interacting.entry.card.classList.add(interacting.kind === "move" ? "dragging" : "resizing");
  }

  const { entry, kind, startBox } = interacting;
  const aspect = entry.aspect;
  let box;
  if (kind === "move") {
    box = { ...startBox, x: Math.max(0, startBox.x + dx), y: Math.max(0, startBox.y + dy) };
  } else {
    // Homothétique : la largeur suit la souris (le plus grand des deux axes).
    const w = Math.min(
      LAYOUT_MAX_WIDTH,
      Math.max(LAYOUT_MIN_WIDTH, Math.max(startBox.w + dx, (startBox.h + dy) / aspect))
    );
    box = { ...startBox, w, h: Math.round(w * aspect) };
  }

  const taken = takenBoxes(entry.snippet.id);
  const snapped = snapBox(box, taken, kind);
  let final = snapped.box;
  final.x = Math.max(0, final.x);
  final = { x: Math.round(final.x), y: Math.round(final.y), w: Math.round(final.w), h: Math.round(final.w * aspect) };

  interacting.result = final;
  placeCard(entry, final);
  showGuides(snapped.guideX, snapped.guideY);
}

async function onPointerUp(event) {
  if (!interacting || event.pointerId !== interacting.pointerId) return;
  const { entry, moved, result } = interacting;
  interacting = null;
  hideGuides();
  entry.card.classList.remove("dragging", "resizing");

  if (!moved || !result) {
    applyLayout(entry);
    await flushPendingReload();
    return;
  }

  // Un glisser ne doit pas se terminer par l'ouverture de l'URL.
  entry.suppressClick = true;
  setTimeout(() => {
    entry.suppressClick = false;
  }, 300);

  entry.snippet = { ...entry.snippet, layout: { x: result.x, y: result.y, w: result.w } };
  const index = snippets.findIndex((s) => s.id === entry.snippet.id);
  if (index >= 0) snippets[index] = entry.snippet;
  applyLayout(entry);
  updateBoardHeight();
  await upsertSnippet(entry.snippet).catch((error) => console.warn("[LLS] layout", error));

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
  await load().catch((error) => console.warn("[LLS] deferred reload", error));
}

/* ----------------------------- construction ----------------------------- */

function createCard(snippet) {
  const card = el("article", "card");

  const img = el("img");
  img.draggable = false;
  img.hidden = true;

  const overlay = el("div", "overlay");

  const pill = el("span", "pill");
  const pillDot = el("span", "pill-dot");
  const pillIcon = el("img", "pill-icon");
  pillIcon.alt = "";
  pillIcon.width = 16;
  pillIcon.height = 16;
  pillIcon.decoding = "async";
  // Favicon indisponible (site hors cache Chrome) : on garde le domaine seul.
  pillIcon.addEventListener("error", () => pill.classList.add("no-icon"));
  const pillHost = el("span", "pill-host");
  pill.append(pillDot, pillIcon, pillHost);

  const tools = el("div", "tools");
  const refreshBtn = el("button", "tool", "");
  refreshBtn.type = "button";
  refreshBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';
  const menuBtn = el("button", "tool card-menu-btn", "");
  menuBtn.type = "button";
  menuBtn.title = "More";
  menuBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
  tools.append(refreshBtn, menuBtn);

  const foot = el("div", "foot");
  const name = el("span", "name");
  const age = el("span", "age");
  foot.append(name, age);

  const handle = el("div", "resize-handle");
  handle.title = "Resize";

  card.append(img, overlay, tools, pill, foot, handle);

  const entry = {
    card,
    img,
    overlay,
    pill,
    pillDot,
    pillIcon,
    pillHost,
    foot,
    name,
    age,
    refreshBtn,
    menuBtn,
    handle,
    objectUrl: null,
    suppressClick: false,
    snippet,
    metaEntry: null,
    image: null,
    aspect: 0.75,
  };

  refreshBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    captureNow(entry.snippet.id);
  });
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (openMenu && entry.card.contains(openMenu)) closeMenu();
    else openCardMenu(entry);
  });
  for (const node of [refreshBtn, menuBtn, pill]) {
    node.addEventListener("pointerdown", (event) => event.stopPropagation());
  }
  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    openUrl(entry.snippet.url);
  });

  card.addEventListener("click", (event) => {
    if (event.target.closest("button, .card-menu, .pill")) return;
    if (entry.suppressClick) {
      entry.suppressClick = false;
      return;
    }
    openUrl(entry.snippet.url);
  });

  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, .card-menu, .resize-handle")) return;
    beginInteraction(entry, "move", event);
  });
  handle.addEventListener("pointerdown", (event) => beginInteraction(entry, "resize", event));

  return entry;
}

/** Rendu complet du plateau. */
function renderAll(images) {
  const seen = new Set();
  for (const snippet of snippets) {
    seen.add(snippet.id);
    let entry = cards.get(snippet.id);
    if (!entry) {
      entry = createCard(snippet);
      cards.set(snippet.id, entry);
      board.appendChild(entry.card);
    }
    entry.snippet = snippet;
    entry.metaEntry = meta[snippet.id] || null;
    if (images) entry.image = images.get(snippet.id) || null;
    entry.aspect = aspectOf(entry.image);
    renderCard(entry);
    applyLayout(entry);
  }

  for (const [id, entry] of cards) {
    if (seen.has(id)) continue;
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.card.remove();
    cards.delete(id);
  }

  updateBoardHeight();

  const isEmpty = snippets.length === 0;
  emptyBox.hidden = !isEmpty;
  board.hidden = isEmpty;
}

/** Recharge l'image d'un seul snippet et rerend sa carte. */
async function refreshOneCard(id) {
  const entry = cards.get(id);
  if (!entry) return;
  entry.metaEntry = meta[id] || null;
  const image = await getImage(id);
  entry.image = image || null;
  const aspect = aspectOf(entry.image);
  renderCard(entry);
  if (Math.abs(aspect - entry.aspect) > 0.001 && !interacting) {
    entry.aspect = aspect;
    applyLayout(entry);
    updateBoardHeight();
  }
}

function updateAges() {
  for (const entry of cards.values()) {
    const capturedAt =
      (entry.image && entry.image.capturedAt) || (entry.metaEntry && entry.metaEntry.capturedAt) || 0;
    entry.age.textContent = relativeTime(capturedAt);
    entry.card.dataset.tone = stalenessClass(entry.snippet, entry.metaEntry);
  }
}

function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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
  runStatusEl.textContent = busy.length === 1 ? "1 capture running" : `${busy.length} captures queued`;
}

async function load() {
  const [loadedSnippets, loadedMeta, images] = await Promise.all([
    getSnippetsForBoard(currentBoardId),
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
    // Scopé au board affiché : le rafraîchissement périodique reste global.
    await chrome.runtime.sendMessage({ type: "captureAll", boardId: currentBoardId });
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

/** Un board a changé ailleurs : re-rendre le sélecteur, basculer si besoin. */
async function onBoardsChanged() {
  boards = await getBoards();
  newTabBoardId = await resolveNewTabBoardId();
  if (!boards.some((b) => b.id === currentBoardId)) {
    // Board supprimé depuis un autre onglet : bascule sur celui du Nouvel Onglet.
    await switchBoard(newTabBoardId);
    return;
  }
  renderBoardMenu();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.boards) {
    onBoardsChanged().catch((error) => console.warn("[LLS] boards changed", error));
  }

  if (changes.settings) {
    // L'épingle « New Tab » du menu suit le réglage, quel que soit l'onglet.
    resolveNewTabBoardId()
      .then((id) => {
        newTabBoardId = id;
        renderBoardMenu();
      })
      .catch((error) => console.warn("[LLS] newTabBoardId", error));
  }

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

// Ajuste la hauteur du plateau si le conteneur change de dimensions.
new ResizeObserver(() => {
  if (interacting) return;
  updateBoardHeight();
}).observe(board);

setInterval(updateAges, 30000);
setInterval(updateClock, 30000);
updateClock();

await resolveBoard();
await load();

// Après le premier rendu seulement : le SW peut enfiler ce qui est périmé.
chrome.runtime
  .sendMessage({ type: "refreshIfStale" })
  .catch((error) => console.warn("[LLS] refreshIfStale", error));
