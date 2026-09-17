// Service worker : alarmes, file de capture persistée, orchestration.
// Le SW peut être tué à tout moment (~30 s d'inactivité) : l'état de la file
// vit dans chrome.storage.session, jamais en mémoire seule.

import { captureSnippet, closeCaptureWindow, teardownCaptureTab } from "./capture.js";
import {
  findFreeSlot,
  getMeta,
  getSettings,
  getSnippet,
  getSnippets,
  isStale,
  patchMeta,
  upsertSnippet,
} from "./storage.js";

const ALARM_TICK = "capture-tick";
const SESSION_KEY = "runState";
const REFRESH_COOLDOWN_MS = 60000;

/** @returns {Promise<{queue: string[], runningSnippetId: string|null, runningTabId: number|null,
 *   runningWindowId: number|null, lastRefreshAt: number}>} */
async function getRunState() {
  const got = await chrome.storage.session.get(SESSION_KEY);
  const raw = got[SESSION_KEY] || {};
  return {
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    runningSnippetId: raw.runningSnippetId || null,
    runningTabId: typeof raw.runningTabId === "number" ? raw.runningTabId : null,
    // Fenêtre de capture dédiée, réutilisée d'un snippet à l'autre ; persistée
    // pour être refermée même si le service worker est tué en pleine capture.
    runningWindowId: typeof raw.runningWindowId === "number" ? raw.runningWindowId : null,
    lastRefreshAt: typeof raw.lastRefreshAt === "number" ? raw.lastRefreshAt : 0,
  };
}

async function setRunState(patch) {
  const current = await getRunState();
  const next = { ...current, ...patch };
  await chrome.storage.session.set({ [SESSION_KEY]: next });
  return next;
}

/** Ajoute des ids en fin de file (sans doublon) et démarre le worker. */
async function enqueue(ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!wanted.length) return { enqueued: 0 };
  const state = await getRunState();
  const queue = state.queue.slice();
  let enqueued = 0;
  for (const id of wanted) {
    if (id === state.runningSnippetId || queue.includes(id)) continue;
    queue.push(id);
    enqueued += 1;
    await patchMeta(id, { queued: true });
  }
  if (enqueued) await setRunState({ queue });
  drainQueue();
  return { enqueued, queueLength: queue.length };
}

let draining = false;

/** Vide la file, une capture à la fois. Le mutex mémoire évite deux boucles
 *  dans la même vie du SW ; `runningSnippetId` en storage.session couvre les
 *  redémarrages. */
async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const state = await getRunState();
      if (state.runningSnippetId) return; // une capture est déjà en cours
      const queue = state.queue.slice();
      const id = queue.shift();
      if (!id) {
        await setRunState({ queue: [] });
        return;
      }
      await setRunState({ queue, runningSnippetId: id, runningTabId: null });

      const snippet = await getSnippet(id);
      if (!snippet) {
        await patchMeta(id, { queued: false });
        await setRunState({ runningSnippetId: null, runningTabId: null });
        continue;
      }

      const settings = await getSettings();
      // `startedAt` sert au détecteur de capture bloquée (voir recoverOrphansIfStuck).
      await patchMeta(id, { status: "capturing", queued: false, startedAt: Date.now() });

      let result;
      try {
        result = await captureSnippet(snippet, settings, {
          captureWindowId: state.runningWindowId,
          onTabOpened: (tabId) => setRunState({ runningTabId: tabId }),
          onWindowOpened: (windowId) => setRunState({ runningWindowId: windowId }),
        });
      } catch (error) {
        // captureSnippet gère déjà ses erreurs ; filet de sécurité.
        result = {
          status: "error",
          lastError: error && error.message ? error.message : String(error),
          lastDurationMs: 0,
        };
      }

      const metaPatch = {
        status: result.status,
        lastError: result.lastError || null,
        warning: result.warning || null,
        blankSuspected: result.blankSuspected === true,
        lastDiag: result.lastDiag || null,
        lastDurationMs: result.lastDurationMs || 0,
        lastAttemptAt: Date.now(),
        queued: false,
      };
      if (result.status === "ok") {
        metaPatch.capturedAt = result.capturedAt;
        metaPatch.width = result.width;
        metaPatch.height = result.height;
      }
      if (result.finalUrl) metaPatch.finalUrl = result.finalUrl;
      await patchMeta(id, metaPatch);

      await setRunState({ runningSnippetId: null, runningTabId: null });
    }
  } finally {
    draining = false;
    // File vide : plus de raison de garder la fenêtre de capture ouverte.
    await closeIdleCaptureWindow().catch((error) =>
      console.warn("[LLS] closeIdleCaptureWindow", error)
    );
  }
}

/** Ferme la fenêtre de capture dédiée si rien n'est en cours ni en attente. */
async function closeIdleCaptureWindow() {
  const state = await getRunState();
  if (state.runningSnippetId || state.queue.length) return;
  if (typeof state.runningWindowId !== "number") return;
  await closeCaptureWindow(state.runningWindowId);
  await setRunState({ runningWindowId: null });
}

/** Nettoie un onglet et une fenêtre de capture orphelins laissés par un SW tué. */
async function recoverOrphans() {
  const state = await getRunState();
  if (typeof state.runningTabId === "number") {
    await teardownCaptureTab(state.runningTabId);
  }
  if (typeof state.runningWindowId === "number") {
    await closeCaptureWindow(state.runningWindowId);
  }
  if (state.runningSnippetId) {
    await patchMeta(state.runningSnippetId, {
      status: "error",
      lastError: "Capture interrupted (service worker restarted).",
      lastAttemptAt: Date.now(),
      queued: false,
    });
  }
  await setRunState({ runningSnippetId: null, runningTabId: null, runningWindowId: null });
}

async function ensureAlarm() {
  const settings = await getSettings();
  const periodInMinutes = Math.max(1, settings.tickMinutes);
  const existing = await chrome.alarms.get(ALARM_TICK);
  if (existing && existing.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes, delayInMinutes: 1 });
}

/** Enfile les snippets activés dont l'image dépasse leur intervalle. */
async function enqueueStale() {
  const [snippets, meta] = await Promise.all([getSnippets(), getMeta()]);
  const now = Date.now();
  const due = snippets
    .filter((s) => s.enabled && s.url)
    .filter((s) => isStale(s, meta[s.id], now))
    .map((s) => s.id);
  return enqueue(due);
}

async function boot() {
  await recoverOrphans();
  await ensureAlarm();
  drainQueue();
}

// Top-level : couvre le réveil du SW hors onStartup/onInstalled.
boot().catch((error) => console.error("[LLS] boot", error));

chrome.runtime.onInstalled.addListener(() => {
  boot().catch((error) => console.error("[LLS] onInstalled", error));
});

chrome.runtime.onStartup.addListener(() => {
  boot().catch((error) => console.error("[LLS] onStartup", error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_TICK) return;
  (async () => {
    await recoverOrphansIfStuck();
    await enqueueStale();
  })().catch((error) => console.error("[LLS] onAlarm", error));
});

/** Si une capture est marquée "en cours" depuis plus de 5 min, c'est un reste. */
async function recoverOrphansIfStuck() {
  const state = await getRunState();
  if (!state.runningSnippetId) return;
  const meta = await getMeta();
  const entry = meta[state.runningSnippetId];
  const startedAt = entry && entry.startedAt ? entry.startedAt : 0;
  if (!startedAt || Date.now() - startedAt > 5 * 60000) await recoverOrphans();
}

// Le tick global a peut-être changé : réaligner l'alarme.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  ensureAlarm().catch((error) => console.error("[LLS] ensureAlarm", error));
});

/* ------------------------------- picker ------------------------------- */

const PICKER_FILE = "picker.js";
const HTTP_URL_RE = /^https?:\/\//i;

/** Pose les drapeaux sur `window` puis injecte le picker dans l'onglet. */
async function injectPicker(tabId, { snippetId = null, openedByOptions = false } = {}) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id, byOptions) => {
      window.__llsPickerTargetId = id;
      window.__llsPickerOpenedByOptions = byOptions;
    },
    args: [snippetId, openedByOptions],
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: [PICKER_FILE] });
}

/** Attend qu'un onglet ait fini de charger (ou abandonne au bout de 30 s). */
function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(done, timeoutMs);
    // L'onglet a pu finir de charger avant l'abonnement.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab && tab.status === "complete") done();
      },
      () => done()
    );
  });
}

/** Ouvre l'URL dans un nouvel onglet et y injecte le picker (flux Options / NTP). */
async function startPicker(url, snippetId) {
  if (!HTTP_URL_RE.test(String(url || ""))) {
    throw new Error("Unsupported URL: only http(s) pages can be captured.");
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);
  await injectPicker(tab.id, { snippetId: snippetId || null, openedByOptions: true });
  return tab.id;
}

/** Place un nouveau snippet dans la première case libre de la grille. */
async function initialLayout(rect) {
  const snippets = await getSnippets();
  const taken = snippets.map((s) => s.layout).filter(Boolean);
  const w = 4;
  const ratio = rect && rect.width ? rect.height / rect.width : 0.75;
  const h = Math.min(8, Math.max(2, Math.round(w * ratio)));
  return findFreeSlot(w, h, taken);
}

/** Crée (ou met à jour) un snippet depuis le résultat du picker. */
async function handlePickerResult(message, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const cancelled = !message.anchorSelector || !message.rect;

  // L'onglet n'est fermé que s'il a été ouvert pour la sélection.
  if (message.openedByOptions && typeof tabId === "number") {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  if (cancelled) return { ok: true, ignored: true };

  const viewport = message.viewport || {};
  const existing = message.snippetId ? await getSnippet(message.snippetId) : null;
  const title = String(message.title || message.url || "Sans titre").slice(0, 60);

  const snippet = existing
    ? {
        ...existing,
        url: message.url || existing.url,
        mode: "anchor",
        anchorSelector: message.anchorSelector,
        offset: message.offset,
        rect: message.rect,
        viewportWidth: Math.round(viewport.width || 0),
        viewportHeight: Math.round(viewport.height || 0),
      }
    : {
        name: title,
        url: message.url || "",
        mode: "anchor",
        anchorSelector: message.anchorSelector,
        offset: message.offset,
        rect: message.rect,
        viewportWidth: Math.round(viewport.width || 0),
        viewportHeight: Math.round(viewport.height || 0),
        layout: await initialLayout(message.rect),
      };

  const saved = await upsertSnippet(snippet);
  await enqueue([saved.id]);

  // À la création seulement : montrer immédiatement la carte qui apparaît.
  if (!existing) chrome.tabs.create({ url: "chrome://newtab" }).catch(() => {});

  return { ok: true, snippetId: saved.id, created: !existing };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (!type) return false;

  (async () => {
    switch (type) {
      case "captureNow": {
        if (!message.snippetId) return { ok: false, error: "snippetId manquant" };
        const res = await enqueue([message.snippetId]);
        return { ok: true, ...res };
      }
      case "captureAll": {
        const snippets = await getSnippets();
        const res = await enqueue(snippets.filter((s) => s.enabled && s.url).map((s) => s.id));
        return { ok: true, ...res };
      }
      case "refreshIfStale": {
        const state = await getRunState();
        if (Date.now() - state.lastRefreshAt < REFRESH_COOLDOWN_MS) {
          return { ok: true, skipped: "rate-limited", enqueued: 0 };
        }
        await setRunState({ lastRefreshAt: Date.now() });
        const res = await enqueueStale();
        return { ok: true, ...res };
      }
      case "getState": {
        const [state, snippets, meta, settings] = await Promise.all([
          getRunState(),
          getSnippets(),
          getMeta(),
          getSettings(),
        ]);
        return {
          ok: true,
          queue: state.queue,
          runningSnippetId: state.runningSnippetId,
          snippets,
          meta,
          settings,
        };
      }
      case "pickerResult":
        return handlePickerResult(message, sender);
      case "startPicker": {
        const tabId = await startPicker(message.url, message.snippetId);
        return { ok: true, tabId };
      }
      default:
        return { ok: false, error: `Message inconnu : ${type}` };
    }
  })().then(sendResponse, (error) =>
    sendResponse({ ok: false, error: error && error.message ? error.message : String(error) })
  );

  return true; // réponse asynchrone
});
