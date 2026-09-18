// Helpers de configuration : boards, snippets, settings et métadonnées.
// Tout vit dans chrome.storage.local sous les clés "boards", "snippets",
// "settings", "meta" et "ui".

export const KEY_SNIPPETS = "snippets";
export const KEY_SETTINGS = "settings";
export const KEY_META = "meta";
export const KEY_BOARDS = "boards";
export const KEY_UI = "ui";

// Board par défaut : id déterministe pour que la migration paresseuse des
// snippets sans boardId ne dépende d'aucun ordre d'exécution.
export const DEFAULT_BOARD_ID = "default";
export const DEFAULT_BOARD_NAME = "Main";
export const BOARD_NAME_MAX = 40;

// Disposition libre de la page Nouvel Onglet.
// Les layouts sont stockés en pixels réels { x, y, w }.
// La hauteur n'est jamais stockée : elle découle du ratio du screenshot pour
// garantir une homothétie stricte.
export const LAYOUT_GAP = 14;
export const LAYOUT_MIN_WIDTH = 180;
export const LAYOUT_DEFAULT_WIDTH = 380;
export const LAYOUT_MAX_WIDTH = 840;

export const DEFAULT_SETTINGS = {
  viewportWidth: 1280,
  viewportHeight: 800,
  tickMinutes: 15,
  waitSelectorTimeoutMs: 15000,
  // Fenêtre popup dédiée : l'onglet y est actif, donc réellement visible pour
  // Chrome. Désactivé par défaut (une fenêtre apparaît brièvement).
  captureWindow: false,
  imagesTimeoutMs: 6000,
  // Board affiché par la page Nouvel Onglet (sans paramètre ?board=).
  newTabBoardId: DEFAULT_BOARD_ID,
};

export const DEFAULT_SNIPPET = {
  boardId: DEFAULT_BOARD_ID,
  name: "",
  url: "",
  enabled: true,
  mode: "viewport",
  selector: "",
  anchorSelector: "",
  offset: { dx: 0, dy: 0, width: 800, height: 600 },
  rect: { x: 0, y: 0, width: 800, height: 600 },
  viewportWidth: 0,
  viewportHeight: 0,
  waitForSelector: "",
  delayMs: 1500,
  intervalMinutes: 15,
  expiredSelector: "",
  freezeAnimations: true,
  scrollPrime: true,
  layout: null,
  fit: "contain",
};

const MODES = new Set(["anchor", "selector", "rect", "viewport"]);

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalise un `layout` libre `{x, y, w}` en pixels réels, migre l'ancien
 * format de grille v0.2 `{col, row, w, h}`, et assainit les largeurs aberrantes.
 */
function normalizeLayout(raw) {
  if (!raw || typeof raw !== "object") return null;

  // 1) Migration format de grille v0.2 : { col, row, w, h }
  if ("col" in raw && !("x" in raw)) {
    const cols = Math.round(num(raw.w, 4, 2, 12));
    const col = Math.round(num(raw.col, 0, 0, 12));
    const row = Math.round(num(raw.row, 0, 0, 1000));
    // w: 4 colonnes -> 380px, 12 colonnes -> 560px
    const w = Math.min(560, Math.max(260, Math.round(cols * 70) + 100));
    return {
      x: Math.round(col * 70),
      y: Math.round(row * 70),
      w,
    };
  }

  // 2) Layout libre { x, y, w } :
  // Si raw.w est disproportionné (ex: bug 1200px / 2500px issu de l'ancienne échelle),
  // on le réinitialise à la taille par défaut pour débloquer immédiatement l'affichage.
  let w = Number(raw.w);
  if (!Number.isFinite(w) || w <= 0 || w >= 950) {
    w = LAYOUT_DEFAULT_WIDTH;
  } else {
    w = Math.min(LAYOUT_MAX_WIDTH, Math.max(LAYOUT_MIN_WIDTH, Math.round(w)));
  }

  const x = Math.max(0, Math.round(num(raw.x, 0, 0, 100000)));
  const y = Math.max(0, Math.round(num(raw.y, 0, 0, 100000)));
  return { x, y, w };
}

/** Complète un snippet partiel avec les défauts et borne les valeurs numériques. */
export function normalizeSnippet(raw) {
  const s = { ...DEFAULT_SNIPPET, ...(raw || {}) };
  const mode = MODES.has(s.mode) ? s.mode : "viewport";
  const rect = s.rect || DEFAULT_SNIPPET.rect;
  const offset = s.offset || DEFAULT_SNIPPET.offset;
  return {
    id: s.id || crypto.randomUUID(),
    // Migration paresseuse : pas de boardId (export v1/v2, snippet 0.3.x) -> "default".
    // Synchrone : aucune vérification d'existence du board ici.
    boardId: String(s.boardId || "").trim() || DEFAULT_BOARD_ID,
    name: String(s.name || "").trim() || String(s.url || "Untitled"),
    url: String(s.url || "").trim(),
    enabled: s.enabled !== false,
    mode,
    selector: String(s.selector || "").trim(),
    anchorSelector: String(s.anchorSelector || "").trim(),
    offset: {
      dx: Math.round(num(offset.dx, 0, -100000, 100000)),
      dy: Math.round(num(offset.dy, 0, -100000, 100000)),
      width: Math.round(num(offset.width, 800, 1, 100000)),
      height: Math.round(num(offset.height, 600, 1, 100000)),
    },
    rect: {
      x: num(rect.x, 0, 0, 100000),
      y: num(rect.y, 0, 0, 100000),
      width: num(rect.width, 800, 1, 100000),
      height: num(rect.height, 600, 1, 100000),
    },
    // 0 = utiliser les réglages globaux.
    viewportWidth: Math.round(num(s.viewportWidth, 0, 0, 3840)),
    viewportHeight: Math.round(num(s.viewportHeight, 0, 0, 4320)),
    waitForSelector: String(s.waitForSelector || "").trim(),
    delayMs: Math.round(num(s.delayMs, 1500, 0, 60000)),
    intervalMinutes: Math.round(num(s.intervalMinutes, 15, 1, 24 * 60)),
    expiredSelector: String(s.expiredSelector || "").trim(),
    freezeAnimations: s.freezeAnimations !== false,
    scrollPrime: s.scrollPrime !== false,
    layout: normalizeLayout(s.layout),
    fit: s.fit === "cover" ? "cover" : "contain",
    createdAt: num(s.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

export async function getSettings() {
  const got = await chrome.storage.local.get(KEY_SETTINGS);
  const raw = got[KEY_SETTINGS] || {};
  return {
    viewportWidth: Math.round(num(raw.viewportWidth, DEFAULT_SETTINGS.viewportWidth, 320, 3840)),
    viewportHeight: Math.round(num(raw.viewportHeight, DEFAULT_SETTINGS.viewportHeight, 240, 4320)),
    tickMinutes: Math.round(num(raw.tickMinutes, DEFAULT_SETTINGS.tickMinutes, 1, 24 * 60)),
    waitSelectorTimeoutMs: Math.round(
      num(raw.waitSelectorTimeoutMs, DEFAULT_SETTINGS.waitSelectorTimeoutMs, 1000, 120000)
    ),
    captureWindow: raw.captureWindow === true,
    imagesTimeoutMs: Math.round(
      num(raw.imagesTimeoutMs, DEFAULT_SETTINGS.imagesTimeoutMs, 0, 60000)
    ),
    // Validation syntaxique seulement : l'existence du board est résolue par
    // resolveNewTabBoardId() (getSettings reste sans lecture des boards).
    newTabBoardId: String(raw.newTabBoardId || "").trim() || DEFAULT_BOARD_ID,
  };
}

/** Board du Nouvel Onglet, garanti existant : réglage sinon premier board. */
export async function resolveNewTabBoardId() {
  const [settings, boards] = await Promise.all([getSettings(), getBoards()]);
  const found = boards.find((b) => b.id === settings.newTabBoardId);
  return found ? found.id : boards[0].id;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
  return getSettings();
}

export async function getSnippets() {
  const got = await chrome.storage.local.get(KEY_SNIPPETS);
  const list = Array.isArray(got[KEY_SNIPPETS]) ? got[KEY_SNIPPETS] : [];
  return list.map(normalizeSnippet);
}

export async function getSnippet(id) {
  const list = await getSnippets();
  return list.find((s) => s.id === id) || null;
}

export async function setSnippets(list) {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeSnippet);
  await chrome.storage.local.set({ [KEY_SNIPPETS]: normalized });
  return normalized;
}

/** Ajoute ou remplace un snippet (par id) et renvoie la liste à jour. */
export async function upsertSnippet(snippet) {
  const normalized = normalizeSnippet(snippet);
  const list = await getSnippets();
  const idx = list.findIndex((s) => s.id === normalized.id);
  if (idx >= 0) list[idx] = normalized;
  else list.push(normalized);
  await chrome.storage.local.set({ [KEY_SNIPPETS]: list });
  return normalized;
}

export async function deleteSnippet(id) {
  const list = await getSnippets();
  await chrome.storage.local.set({ [KEY_SNIPPETS]: list.filter((s) => s.id !== id) });
  await deleteMetaFor(id);
}

export async function getMeta() {
  const got = await chrome.storage.local.get(KEY_META);
  const meta = got[KEY_META];
  return meta && typeof meta === "object" ? meta : {};
}

export async function getMetaFor(id) {
  const meta = await getMeta();
  return meta[id] || null;
}

/** Fusionne un patch dans meta[id] (déclenche storage.onChanged pour les pages ouvertes). */
export async function patchMeta(id, patch) {
  const meta = await getMeta();
  meta[id] = { ...(meta[id] || {}), ...patch };
  await chrome.storage.local.set({ [KEY_META]: meta });
  return meta[id];
}

export async function deleteMetaFor(id) {
  const meta = await getMeta();
  if (!(id in meta)) return;
  delete meta[id];
  await chrome.storage.local.set({ [KEY_META]: meta });
}

/* -------------------------------- boards -------------------------------- */

/** Normalise un board partiel : id, nom borné à 40 caractères, date de création. */
function normalizeBoard(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const name = String(b.name || "").trim().slice(0, BOARD_NAME_MAX);
  return {
    id: String(b.id || "").trim() || crypto.randomUUID(),
    name: name || DEFAULT_BOARD_NAME,
    createdAt: num(b.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * Liste des boards, jamais vide : si le stockage est vide (première ouverture
 * de 0.4.0), le board "default" est créé et persisté à la volée.
 */
export async function getBoards() {
  const got = await chrome.storage.local.get(KEY_BOARDS);
  const list = Array.isArray(got[KEY_BOARDS]) ? got[KEY_BOARDS] : [];
  const boards = list.map(normalizeBoard);
  if (boards.length) return boards;
  const fallback = [
    { id: DEFAULT_BOARD_ID, name: DEFAULT_BOARD_NAME, createdAt: Date.now() },
  ];
  await chrome.storage.local.set({ [KEY_BOARDS]: fallback });
  return fallback;
}

export async function setBoards(list) {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeBoard);
  await chrome.storage.local.set({ [KEY_BOARDS]: normalized });
  // Passe par getBoards() pour conserver l'invariant « jamais vide ».
  return getBoards();
}

export async function getBoard(id) {
  const boards = await getBoards();
  return boards.find((b) => b.id === id) || null;
}

export async function createBoard(name) {
  const clean = String(name || "").trim().slice(0, BOARD_NAME_MAX);
  if (!clean) throw new Error("Board name is required.");
  const boards = await getBoards();
  const board = { id: crypto.randomUUID(), name: clean, createdAt: Date.now() };
  boards.push(board);
  await chrome.storage.local.set({ [KEY_BOARDS]: boards });
  return board;
}

export async function renameBoard(id, name) {
  const clean = String(name || "").trim().slice(0, BOARD_NAME_MAX);
  if (!clean) throw new Error("Board name is required.");
  const boards = await getBoards();
  const board = boards.find((b) => b.id === id);
  if (!board) throw new Error("Unknown board.");
  board.name = clean;
  await chrome.storage.local.set({ [KEY_BOARDS]: boards });
  return board;
}

/**
 * Supprime un board, ses snippets et leurs meta. Le dernier board ne peut pas
 * être supprimé. L'appelant purge les images IndexedDB des ids renvoyés.
 */
export async function deleteBoard(id) {
  const boards = await getBoards();
  if (boards.length <= 1) throw new Error("The last board cannot be deleted.");
  const remaining = boards.filter((b) => b.id !== id);
  if (remaining.length === boards.length) throw new Error("Unknown board.");

  const snippets = await getSnippets();
  const deletedSnippetIds = snippets.filter((s) => s.boardId === id).map((s) => s.id);
  const meta = await getMeta();
  for (const snippetId of deletedSnippetIds) delete meta[snippetId];

  await chrome.storage.local.set({
    [KEY_BOARDS]: remaining,
    [KEY_SNIPPETS]: snippets.filter((s) => s.boardId !== id),
    [KEY_META]: meta,
  });

  // Le board du Nouvel Onglet disparaît : bascule sur le premier restant.
  const settings = await getSettings();
  if (settings.newTabBoardId === id) {
    await setSettings({ newTabBoardId: remaining[0].id });
  }
  return { deletedSnippetIds };
}

export async function getSnippetsForBoard(boardId) {
  const list = await getSnippets();
  return list.filter((s) => s.boardId === boardId);
}

/* ---------------------------- état d'interface --------------------------- */

/** État d'interface non critique (ex. lastBoardId pour la présélection capture). */
export async function getUi() {
  const got = await chrome.storage.local.get(KEY_UI);
  const ui = got[KEY_UI];
  return ui && typeof ui === "object" ? ui : {};
}

export async function patchUi(patch) {
  const next = { ...(await getUi()), ...(patch || {}) };
  await chrome.storage.local.set({ [KEY_UI]: next });
  return next;
}

/** true si le snippet n'a jamais été capturé ou si son image dépasse son intervalle. */
export function isStale(snippet, metaEntry, now = Date.now()) {
  const capturedAt = metaEntry && metaEntry.capturedAt ? metaEntry.capturedAt : 0;
  if (!capturedAt) return true;
  return now - capturedAt >= snippet.intervalMinutes * 60000;
}

/* ---------------------------- placement libre ---------------------------- */

/** Ratio hauteur/largeur d'une image capturée (4:3 par défaut). */
export function aspectOf(image) {
  const iw = image && image.width ? image.width : 0;
  const ih = image && image.height ? image.height : 0;
  if (!iw || !ih) return 0.75;
  return Math.min(4, Math.max(0.15, ih / iw));
}

/** Boîte `{x, y, w, h}` d'un layout pour un ratio donné. */
export function boxOf(layout, aspect) {
  return { x: layout.x, y: layout.y, w: layout.w, h: Math.round(layout.w * aspect) };
}

function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** true si `box` ne chevauche aucune des `taken` (boîtes `{x,y,w,h}`). */
export function fitsFree(box, taken = []) {
  if (!box || box.x < 0 || box.y < 0 || box.w < LAYOUT_MIN_WIDTH) return false;
  return !taken.some((other) => overlaps(box, other));
}

/**
 * Première position libre pour une boîte `w × h` : balayage des coins libres
 * en respectant la largeur maximale du plateau.
 */
export function findFreeSpot(w, h, taken = [], maxWidth = 1600) {
  const width = Math.min(LAYOUT_MAX_WIDTH, Math.max(LAYOUT_MIN_WIDTH, Math.round(w || LAYOUT_DEFAULT_WIDTH)));
  const height = Math.max(80, Math.round(h || width * 0.75));
  const maxW = Math.max(width + 40, maxWidth);
  const xs = new Set([0]);
  const ys = new Set([0]);
  for (const b of taken) {
    xs.add(b.x + b.w + LAYOUT_GAP);
    xs.add(b.x);
    ys.add(b.y + b.h + LAYOUT_GAP);
    ys.add(b.y);
  }
  const candidates = [];
  for (const y of ys) {
    for (const x of xs) {
      candidates.push({ x, y, w: width, h: height });
    }
  }
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of candidates) {
    if (c.x + c.w > maxW) continue;
    if (!taken.some((other) => overlaps(c, other, LAYOUT_GAP))) return { x: c.x, y: c.y, w: width };
  }
  const bottom = taken.reduce((acc, b) => Math.max(acc, b.y + b.h + LAYOUT_GAP), 0);
  return { x: 0, y: bottom, w: width };
}

// Alias pour compatibilité
export const findFreeSlot = findFreeSpot;
