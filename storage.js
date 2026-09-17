// Helpers de configuration : snippets, settings et métadonnées.
// Tout vit dans chrome.storage.local sous les clés "snippets", "settings", "meta".

export const KEY_SNIPPETS = "snippets";
export const KEY_SETTINGS = "settings";
export const KEY_META = "meta";

// Disposition libre de la page Nouvel Onglet. Les layouts sont exprimés en
// pixels dans une largeur de référence (LAYOUT_REF_WIDTH) et mis à l'échelle
// selon la largeur réelle de la fenêtre : l'arrangement reste proportionnel.
// La hauteur n'est jamais stockée : elle découle du ratio du screenshot.
export const LAYOUT_REF_WIDTH = 1200;
export const LAYOUT_GAP = 12;
export const LAYOUT_MIN_WIDTH = 140;
export const LAYOUT_DEFAULT_WIDTH = 380;

// Ancienne grille 12 colonnes (v0.2) : conservée pour migrer les layouts.
const LEGACY_COLUMNS = 12;
const LEGACY_CELL = (LAYOUT_REF_WIDTH - LAYOUT_GAP * (LEGACY_COLUMNS - 1)) / LEGACY_COLUMNS;

export const DEFAULT_SETTINGS = {
  viewportWidth: 1280,
  viewportHeight: 800,
  tickMinutes: 15,
  waitSelectorTimeoutMs: 15000,
  // Fenêtre popup dédiée : l'onglet y est actif, donc réellement visible pour
  // Chrome. Désactivé par défaut (une fenêtre apparaît brièvement).
  captureWindow: false,
  imagesTimeoutMs: 6000,
};

export const DEFAULT_SNIPPET = {
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
 * Normalise un `layout` libre `{x, y, w}` (pixels de référence), migre l'ancien
 * format de grille `{col, row, w, h}`, ou renvoie null s'il est absent/invalide.
 */
function normalizeLayout(raw) {
  if (!raw || typeof raw !== "object") return null;
  if ("col" in raw && !("x" in raw)) {
    const cols = Math.round(num(raw.w, 4, 2, LEGACY_COLUMNS));
    const col = Math.round(num(raw.col, 0, 0, LEGACY_COLUMNS - cols));
    const row = Math.round(num(raw.row, 0, 0, 10000));
    return {
      x: Math.round(col * (LEGACY_CELL + LAYOUT_GAP)),
      y: Math.round(row * (LEGACY_CELL + LAYOUT_GAP)),
      w: Math.round(cols * LEGACY_CELL + (cols - 1) * LAYOUT_GAP),
    };
  }
  const w = Math.round(num(raw.w, LAYOUT_DEFAULT_WIDTH, LAYOUT_MIN_WIDTH, LAYOUT_REF_WIDTH));
  const x = Math.round(num(raw.x, 0, 0, LAYOUT_REF_WIDTH - w));
  const y = Math.round(num(raw.y, 0, 0, 100000));
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
  };
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

/** true si `box` ne chevauche aucune des `taken` (boîtes `{x,y,w,h}`) et reste dans la largeur. */
export function fitsFree(box, taken) {
  if (!box || box.x < 0 || box.y < 0 || box.w < LAYOUT_MIN_WIDTH) return false;
  if (box.x + box.w > LAYOUT_REF_WIDTH) return false;
  return !taken.some((other) => overlaps(box, other));
}

/**
 * Première position libre pour une boîte `w × h` : on balaie les candidats
 * (0,0) puis les coins droits/bas des boîtes existantes, du plus haut au plus
 * bas. Renvoie toujours un layout : en dernier recours, sous tout le reste.
 */
export function findFreeSpot(w, h, taken) {
  const width = Math.min(LAYOUT_REF_WIDTH, Math.max(LAYOUT_MIN_WIDTH, Math.round(w)));
  const xs = new Set([0]);
  const ys = new Set([0]);
  for (const b of taken) {
    xs.add(b.x + b.w + LAYOUT_GAP);
    xs.add(b.x);
    ys.add(b.y + b.h + LAYOUT_GAP);
    ys.add(b.y);
  }
  const candidates = [];
  for (const y of ys) for (const x of xs) candidates.push({ x, y, w: width, h });
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of candidates) {
    if (c.x + c.w > LAYOUT_REF_WIDTH) continue;
    if (!taken.some((other) => overlaps(c, other, LAYOUT_GAP))) return { x: c.x, y: c.y, w: width };
  }
  const bottom = taken.reduce((acc, b) => Math.max(acc, b.y + b.h + LAYOUT_GAP), 0);
  return { x: 0, y: bottom, w: width };
}
