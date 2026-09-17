// Helpers de configuration : snippets, settings et métadonnées.
// Tout vit dans chrome.storage.local sous les clés "snippets", "settings", "meta".

export const KEY_SNIPPETS = "snippets";
export const KEY_SETTINGS = "settings";
export const KEY_META = "meta";

// Grille de la page Nouvel Onglet : 12 colonnes, cellules carrées.
export const GRID_COLUMNS = 12;
export const GRID_GAP = 12;

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

/** Normalise un `layout` de grille, ou renvoie null s'il est absent/invalide. */
function normalizeLayout(raw) {
  if (!raw || typeof raw !== "object") return null;
  const w = Math.round(num(raw.w, 4, 2, GRID_COLUMNS));
  const h = Math.round(num(raw.h, 3, 1, 40));
  const col = Math.round(num(raw.col, 0, 0, GRID_COLUMNS - w));
  const row = Math.round(num(raw.row, 0, 0, 10000));
  return { col, row, w, h };
}

/** Complète un snippet partiel avec les défauts et borne les valeurs numériques. */
export function normalizeSnippet(raw) {
  const s = { ...DEFAULT_SNIPPET, ...(raw || {}) };
  const mode = MODES.has(s.mode) ? s.mode : "viewport";
  const rect = s.rect || DEFAULT_SNIPPET.rect;
  const offset = s.offset || DEFAULT_SNIPPET.offset;
  return {
    id: s.id || crypto.randomUUID(),
    name: String(s.name || "").trim() || String(s.url || "Sans titre"),
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

/* --------------------------- placement en grille --------------------------- */

function overlaps(a, b) {
  return (
    a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h
  );
}

/** true si `layout` ne chevauche aucun des `taken` (bornes de grille incluses). */
export function fitsInGrid(layout, taken) {
  if (!layout) return false;
  if (layout.col < 0 || layout.row < 0 || layout.w < 2 || layout.h < 1) return false;
  if (layout.col + layout.w > GRID_COLUMNS) return false;
  return !taken.some((other) => overlaps(layout, other));
}

/**
 * Première position libre, balayage ligne par ligne puis colonne par colonne
 * (« first fit »). Renvoie toujours un layout : la grille est verticalement
 * infinie, donc on finit forcément par trouver une ligne vide.
 */
export function findFreeSlot(w, h, taken) {
  const width = Math.min(GRID_COLUMNS, Math.max(2, Math.round(w)));
  const height = Math.max(1, Math.round(h));
  const maxRow = taken.reduce((acc, l) => Math.max(acc, l.row + l.h), 0);
  for (let row = 0; row <= maxRow; row += 1) {
    for (let col = 0; col <= GRID_COLUMNS - width; col += 1) {
      const candidate = { col, row, w: width, h: height };
      if (fitsInGrid(candidate, taken)) return candidate;
    }
  }
  return { col: 0, row: maxRow, w: width, h: height };
}

/** Taille de carte déduite du ratio de l'image : 4 colonnes de large, hauteur bornée. */
export function layoutSizeForImage(image) {
  const w = 4;
  const iw = image && image.width ? image.width : 0;
  const ih = image && image.height ? image.height : 0;
  if (!iw || !ih) return { w, h: 3 };
  const h = Math.round((w * ih) / iw);
  return { w, h: Math.min(8, Math.max(2, h)) };
}
