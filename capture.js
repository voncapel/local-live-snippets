// Capture d'une zone de page via un vrai onglet + chrome.debugger (CDP).
// On rend dans un onglet réel du profil : les cookies/sessions sont réutilisés
// naturellement, contrairement à un offscreen document.
//
// Un onglet d'arrière-plan est « caché » pour Chrome : visibilityState vaut
// "hidden", requestAnimationFrame est gelé, IntersectionObserver ne délivre
// plus ses callbacks et beaucoup de SPA suspendent leur rendu — d'où des
// captures noires ou vides. Trois contre-mesures, du plus léger au plus sûr :
// émulation de visibilité injectée avant navigation, amorçage du lazy-loading,
// et fenêtre de capture dédiée (réglage `captureWindow`).

import { putImage } from "./db.js";

const CDP_VERSION = "1.3";
const LOAD_TIMEOUT_MS = 30000;
const LOGIN_URL_RE = /login|signin|sign-in|auth|sso/i;
const MAX_EMULATED_HEIGHT = 6000;
// Au-delà de cette fraction de pixels quasi identiques, l'image est jugée vide.
const BLANK_UNIFORMITY = 0.97;
const BLANK_TOLERANCE = 8;
const BLANK_RETRY_WAIT_MS = 2000;

// Onglets pour lesquels le debugger s'est détaché tout seul (onglet fermé,
// clic sur "Annuler" dans la barre de débogage, DevTools ouvert…).
const detachedTabs = new Set();

chrome.debugger.onDetach.addListener((source) => {
  if (source && typeof source.tabId === "number") detachedTabs.add(source.tabId);
});

/** Rejette si `promise` ne se règle pas en `ms` millisecondes. */
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out (${ms} ms): ${label}`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** chrome.debugger.sendCommand en promesse (MV3 renvoie déjà une promesse). */
export function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

/** Écoute un événement CDP une seule fois ; `cancel()` retire toujours le listener. */
function onceEvent(tabId, eventName) {
  let listener;
  const promise = new Promise((resolve) => {
    listener = (source, method, params) => {
      if (source.tabId === tabId && method === eventName) resolve(params || {});
    };
    chrome.debugger.onEvent.addListener(listener);
  });
  return {
    promise,
    cancel() {
      if (listener) chrome.debugger.onEvent.removeListener(listener);
    },
  };
}

async function evaluate(tabId, expression, options = {}) {
  const { awaitPromise = false, timeoutMs = 10000, label = "Runtime.evaluate" } = options;
  const res = await withTimeout(
    send(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise }),
    timeoutMs,
    label
  );
  if (res && res.exceptionDetails) {
    const details = res.exceptionDetails;
    const message =
      (details.exception && (details.exception.description || details.exception.value)) ||
      details.text ||
      "exception inconnue";
    throw new Error(`Page script error (${label}): ${message}`);
  }
  return res && res.result ? res.result.value : undefined;
}

/** Attend que requestAnimationFrame se soit exécuté, avec repli sur un timer :
 *  dans un onglet d'arrière-plan, rAF peut être gelé. */
const AWAIT_FRAME_JS = `new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => requestAnimationFrame(finish));
  setTimeout(finish, 250);
})`;

const FREEZE_CSS = "* { animation: none !important; transition: none !important; caret-color: transparent !important }";

/* --------------------------- émulation de visibilité --------------------------- */

/**
 * Script injecté dans *chaque* document avant tout script de la page
 * (`Page.addScriptToEvaluateOnNewDocument`). Il fait croire à la page qu'elle
 * est visible et focalisée, et garantit que les callbacks rAF finissent par
 * tourner même si le navigateur a gelé l'horloge d'animation de l'onglet.
 */
const VISIBILITY_BOOTSTRAP_JS = `(() => {
  const define = (target, prop, descriptor) => {
    try {
      Object.defineProperty(target, prop, { configurable: true, ...descriptor });
    } catch (_) {
      // Propriété non redéfinissable sur ce moteur : on continue.
    }
  };

  define(Document.prototype, "visibilityState", { get: () => "visible" });
  define(Document.prototype, "hidden", { get: () => false });
  define(Document.prototype, "webkitVisibilityState", { get: () => "visible" });
  define(Document.prototype, "webkitHidden", { get: () => false });
  define(Document.prototype, "hasFocus", { value: () => true, writable: true });

  // Les frameworks qui écoutent ces événements mettent le rendu en pause :
  // on les coupe au vol, en phase de capture, avant tout autre listener.
  const swallow = (event) => {
    event.stopImmediatePropagation();
  };
  for (const name of ["visibilitychange", "webkitvisibilitychange"]) {
    document.addEventListener(name, swallow, true);
  }
  for (const name of ["blur", "pagehide"]) {
    window.addEventListener(name, swallow, true);
    document.addEventListener(name, swallow, true);
  }

  // rAF avec filet de sécurité : si le rAF natif n'a pas rappelé en ~100 ms,
  // on prend le relais via setTimeout(16). Le callback ne part qu'une fois.
  const nativeRaf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : null;
  const nativeCancel = window.cancelAnimationFrame
    ? window.cancelAnimationFrame.bind(window)
    : null;
  if (nativeRaf) {
    const pending = new Map();
    let nextId = 1;

    window.requestAnimationFrame = function (callback) {
      if (typeof callback !== "function") return 0;
      const id = nextId++;
      const entry = { done: false, rafId: undefined, timerId: undefined };
      const fire = () => {
        if (entry.done) return;
        entry.done = true;
        pending.delete(id);
        if (nativeCancel && entry.rafId !== undefined) nativeCancel(entry.rafId);
        clearTimeout(entry.timerId);
        callback(performance.now());
      };
      pending.set(id, entry);
      entry.rafId = nativeRaf(fire);
      entry.timerId = setTimeout(() => {
        entry.timerId = setTimeout(fire, 16);
      }, 100);
      return id;
    };

    window.cancelAnimationFrame = function (id) {
      const entry = pending.get(id);
      if (!entry) {
        if (nativeCancel) nativeCancel(id);
        return;
      }
      entry.done = true;
      pending.delete(id);
      if (nativeCancel && entry.rafId !== undefined) nativeCancel(entry.rafId);
      clearTimeout(entry.timerId);
    };
  }
})();`;

/** Pose l'émulation de visibilité. À appeler après `Page.enable`, avant `Page.navigate`. */
async function installVisibilityEmulation(tabId) {
  await send(tabId, "Page.addScriptToEvaluateOnNewDocument", {
    source: VISIBILITY_BOOTSTRAP_JS,
  });
  try {
    await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (_) {
    // Commande absente sur cette version de Chrome : non bloquant.
  }
}

/* --------------------------- amorçage du lazy-loading --------------------------- */

/**
 * Script page qui force le chargement de ce qui est différé dans et autour de
 * la zone cible : `loading="eager"`, `data-src` → `src`, pré-scroll progressif,
 * puis attente des `<img>` qui croisent le rect et de `document.fonts.ready`.
 */
function primeScript(configJson) {
  return `(async () => {
  const cfg = ${configJson};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startedAt = Date.now();
  const PLACEHOLDER_RE = /^data:image\\/(gif|png|svg\\+xml|webp);/i;

  // 1) Tout ce qui est différé devient immédiat.
  let promoted = 0;
  for (const node of document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) {
    node.loading = "eager";
    promoted += 1;
  }
  for (const node of document.querySelectorAll("img[data-src], img[data-srcset], iframe[data-src]")) {
    const src = node.getAttribute("src") || "";
    const dataSrc = node.getAttribute("data-src");
    if (dataSrc && (!src || PLACEHOLDER_RE.test(src))) node.setAttribute("src", dataSrc);
    const dataSrcset = node.getAttribute("data-srcset");
    if (dataSrcset && !node.getAttribute("srcset")) node.setAttribute("srcset", dataSrcset);
  }

  // 2) Pré-scroll par pas d'un viewport : réveille les IntersectionObserver.
  const targetBottom = Math.max(0, cfg.rect.y + cfg.rect.height + 600);
  const docHeight = Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0,
    1
  );
  const step = Math.max(200, window.innerHeight || 800);
  const limit = Math.min(targetBottom, docHeight);
  let steps = 0;
  if (cfg.scrollPrime) {
    for (let y = 0; y <= limit; y += step) {
      window.scrollTo(0, y);
      steps += 1;
      await wait(120);
      // Budget de sécurité : une page qui s'allonge sans fin ne doit pas nous bloquer.
      if (Date.now() - startedAt > cfg.scrollBudgetMs) break;
    }
  }
  // Retour sur la cible avant la mesure.
  window.scrollTo(0, Math.max(0, cfg.rect.y - 40));
  await wait(150);

  // 3) Attente des images qui croisent la cible.
  const intersectsTarget = (node) => {
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const top = r.top + window.scrollY;
    const left = r.left + window.scrollX;
    return (
      top < cfg.rect.y + cfg.rect.height &&
      cfg.rect.y < top + r.height &&
      left < cfg.rect.x + cfg.rect.width &&
      cfg.rect.x < left + r.width
    );
  };

  const targets = Array.from(document.images).filter(intersectsTarget);
  // Une image déjà "complete" ici a fini son sort (chargée, vide ou en erreur).
  const alreadyDone = new WeakSet();
  for (const img of targets) {
    if (img.complete) alreadyDone.add(img);
  }
  const errored = new WeakSet();
  const onError = (event) => {
    if (event.target && event.target.tagName === "IMG") errored.add(event.target);
  };
  document.addEventListener("error", onError, true);

  const settled = (img) =>
    img.complete && (img.naturalWidth > 0 || alreadyDone.has(img) || errored.has(img));

  const deadline = Date.now() + cfg.imagesTimeoutMs;
  let pendingImages = 0;
  for (;;) {
    pendingImages = targets.reduce((acc, img) => acc + (settled(img) ? 0 : 1), 0);
    if (!pendingImages || Date.now() >= deadline) break;
    await wait(150);
  }
  document.removeEventListener("error", onError, true);

  // 4) Polices : un texte en FOIT est du blanc sur blanc.
  if (document.fonts && document.fonts.ready) {
    try {
      await Promise.race([document.fonts.ready, wait(1500)]);
    } catch (_) {
      // fonts.ready rejeté : rien à faire de plus.
    }
  }

  return { promoted, images: targets.length, pendingImages, steps };
})()`;
}

/**
 * Amorce le lazy-loading autour de `targetRect` (coordonnées de page).
 * Ne lève pas : un amorçage raté ne doit pas faire échouer la capture.
 */
async function primeLazyContent(tabId, targetRect, options = {}) {
  // 0 est une valeur légitime : « ne pas attendre les images ».
  const imagesTimeoutMs = Number.isFinite(options.imagesTimeoutMs)
    ? Math.max(0, options.imagesTimeoutMs)
    : 6000;
  const scrollPrime = options.scrollPrime !== false;
  const scrollBudgetMs = 20000;
  const config = JSON.stringify({
    rect: {
      x: Math.max(0, Math.round(targetRect.x || 0)),
      y: Math.max(0, Math.round(targetRect.y || 0)),
      width: Math.max(1, Math.round(targetRect.width || 1)),
      height: Math.max(1, Math.round(targetRect.height || 1)),
    },
    imagesTimeoutMs,
    scrollPrime,
    scrollBudgetMs,
  });
  try {
    return await evaluate(tabId, primeScript(config), {
      awaitPromise: true,
      timeoutMs: imagesTimeoutMs + scrollBudgetMs + 10000,
      label: "lazy-loading priming",
    });
  } catch (error) {
    console.warn("[LLS] amorçage du lazy-loading", error);
    return null;
  }
}

/* ----------------------------- détection d'image vide ----------------------------- */

/**
 * Décode l'image et mesure son uniformité sur une vignette 64×64 : fraction de
 * pixels à ±`BLANK_TOLERANCE` de la couleur dominante. Une capture noire ou
 * un bloc gris uni tombent à ~1.
 *
 * @returns {Promise<{uniformity: number, blank: boolean}|null>} null si indécodable
 */
export async function analyzeBlankness(blob) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
    const size = 64;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const total = size * size;

    // Couleur dominante par histogramme grossier (16 niveaux par canal),
    // plus robuste qu'une moyenne quand un logo tranche sur un fond uni.
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const slot = buckets.get(key);
      if (slot) {
        slot.count += 1;
        slot.r += data[i];
        slot.g += data[i + 1];
        slot.b += data[i + 2];
      } else {
        buckets.set(key, { count: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }
    let dominant = null;
    for (const slot of buckets.values()) {
      if (!dominant || slot.count > dominant.count) dominant = slot;
    }
    if (!dominant) return null;
    const refR = dominant.r / dominant.count;
    const refG = dominant.g / dominant.count;
    const refB = dominant.b / dominant.count;

    let near = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - refR) <= BLANK_TOLERANCE &&
        Math.abs(data[i + 1] - refG) <= BLANK_TOLERANCE &&
        Math.abs(data[i + 2] - refB) <= BLANK_TOLERANCE
      ) {
        near += 1;
      }
    }
    const uniformity = near / total;
    return { uniformity, blank: uniformity > BLANK_UNIFORMITY };
  } catch (error) {
    console.warn("[LLS] analyse d'uniformité", error);
    return null;
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
}

/* ------------------------------ surface de capture ------------------------------ */

async function pickWindowId() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.type === "normal" && typeof win.id === "number") return win.id;
  } catch (_) {
    /* pas de fenêtre focalisée : on tente autre chose */
  }
  try {
    const all = await chrome.windows.getAll({ populate: false });
    const normal = all.find((w) => w.type === "normal");
    if (normal) return normal.id;
  } catch (_) {
    /* aucune fenêtre : tabs.create ouvrira où il peut */
  }
  return undefined;
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Ouvre l'onglet de capture (épinglé, inactif, muet) et renvoie son id. */
export async function openCaptureTab() {
  const windowId = await pickWindowId();
  const createProps = { url: "about:blank", active: false, pinned: true };
  if (typeof windowId === "number") createProps.windowId = windowId;
  const tab = await chrome.tabs.create(createProps);
  if (!tab || typeof tab.id !== "number") throw new Error("Could not create the capture tab");
  try {
    await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
  } catch (_) {
    // Non bloquant : certains états d'onglet refusent ces flags.
  }
  return tab.id;
}

/**
 * Fenêtre popup dédiée à la capture. L'onglet y est *actif*, donc réellement
 * « visible » pour Chrome : rAF tourne, IntersectionObserver délivre. Elle
 * n'est jamais focalisée (`focused: false`) et apparaît brièvement derrière la
 * fenêtre courante. L'API `chrome.windows` ne demande aucune permission en MV3.
 */
async function ensureCaptureWindow(existingWindowId, width, height) {
  if (typeof existingWindowId === "number") {
    try {
      const win = await chrome.windows.get(existingWindowId, { populate: true });
      if (win && typeof win.id === "number") {
        const firstTab = win.tabs && win.tabs.length ? win.tabs[0] : null;
        return { windowId: win.id, tabId: firstTab ? firstTab.id : undefined, created: false };
      }
    } catch (_) {
      // Fenêtre fermée entre deux captures : on en recrée une.
    }
  }
  const win = await chrome.windows.create({
    url: "about:blank",
    type: "popup",
    focused: false,
    width: Math.max(320, Math.round(width)),
    height: Math.max(240, Math.round(height)),
    left: 0,
    top: 0,
    state: "normal",
  });
  if (!win || typeof win.id !== "number") throw new Error("Could not create the capture window");
  const firstTab = win.tabs && win.tabs.length ? win.tabs[0] : null;
  return { windowId: win.id, tabId: firstTab ? firstTab.id : undefined, created: true };
}

/**
 * Prépare l'onglet dans lequel la capture va se faire.
 *
 * En mode fenêtre dédiée on réutilise l'unique onglet de la popup : le fermer
 * fermerait la fenêtre, ce qui ferait clignoter une nouvelle fenêtre à chaque
 * snippet. Le détachement du debugger suffit à remettre l'onglet à zéro
 * (émulations et scripts d'amorçage sont posés par attachement).
 *
 * @returns {Promise<{tabId: number, windowId: number|null, keepTab: boolean, warning: string|null}>}
 */
export async function openCaptureSurface(settings, existingWindowId, viewport = {}) {
  if (!settings || !settings.captureWindow) {
    return { tabId: await openCaptureTab(), windowId: null, keepTab: false, warning: null };
  }
  try {
    const ensured = await ensureCaptureWindow(
      existingWindowId,
      viewport.width || 1280,
      viewport.height || 800
    );
    let tabId = ensured.tabId;
    if (typeof tabId !== "number") {
      const tabs = await chrome.tabs.query({ windowId: ensured.windowId });
      const first = tabs.find((t) => typeof t.id === "number");
      if (!first) throw new Error("Capture window has no tab");
      tabId = first.id;
    }
    try {
      await chrome.tabs.update(tabId, { muted: true, autoDiscardable: false, active: true });
    } catch (_) {
      /* non bloquant */
    }
    return { tabId, windowId: ensured.windowId, keepTab: true, warning: null };
  } catch (error) {
    // Repli sur l'onglet épinglé : mieux vaut une capture peut-être vide que
    // pas de capture du tout.
    return {
      tabId: await openCaptureTab(),
      windowId: null,
      keepTab: false,
      warning: `Capture window unavailable (${
        error && error.message ? error.message : String(error)
      }), falling back to a background tab`,
    };
  }
}

/** Détache le debugger et ferme l'onglet ; ne lève jamais.
 *  `keepTab` conserve l'onglet (fenêtre de capture dédiée réutilisée) : on le
 *  ramène alors sur `about:blank` pour ne rien laisser tourner entre deux
 *  captures. */
export async function teardownCaptureTab(tabId, keepTab = false) {
  if (typeof tabId !== "number") return;
  if (!detachedTabs.has(tabId)) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      /* déjà détaché */
    }
  }
  detachedTabs.delete(tabId);
  if (keepTab) {
    try {
      await chrome.tabs.update(tabId, { url: "about:blank" });
    } catch (_) {
      /* onglet disparu */
    }
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    /* déjà fermé */
  }
}

/** Ferme la fenêtre de capture dédiée ; ne lève jamais. */
export async function closeCaptureWindow(windowId) {
  if (typeof windowId !== "number") return;
  try {
    await chrome.windows.remove(windowId);
  } catch (_) {
    /* déjà fermée */
  }
}

/* --------------------------------- mesure --------------------------------- */

const MEASURE_JS = (selectorJson) => `(async () => {
  const el = document.querySelector(${selectorJson});
  if (!el) return null;
  el.scrollIntoView({ block: "start", inline: "nearest" });
  await ${AWAIT_FRAME_JS};
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height,
           scrollX: window.scrollX, scrollY: window.scrollY };
})()`;

/**
 * Calcule le rect à capturer en coordonnées de page.
 * @returns {Promise<{clip: object|null, warning: string|null, notFound: string|null}>}
 */
async function measureTarget(tabId, snippet, viewportWidth, viewportHeight) {
  if (snippet.mode === "anchor") {
    const measured = await evaluate(tabId, MEASURE_JS(JSON.stringify(snippet.anchorSelector)), {
      awaitPromise: true,
      timeoutMs: 15000,
      label: "anchor measurement",
    });
    if (measured && measured.width >= 1 && measured.height >= 1) {
      return {
        clip: {
          x: measured.x + measured.scrollX + snippet.offset.dx,
          y: measured.y + measured.scrollY + snippet.offset.dy,
          width: snippet.offset.width,
          height: snippet.offset.height,
        },
        warning: null,
        notFound: null,
      };
    }
    // Repli non bloquant : on capture aux coordonnées absolues mémorisées.
    return {
      clip: { ...snippet.rect },
      warning: "Anchor not found, captured by coordinates",
      notFound: null,
    };
  }

  if (snippet.mode === "selector") {
    const measured = await evaluate(tabId, MEASURE_JS(JSON.stringify(snippet.selector)), {
      awaitPromise: true,
      timeoutMs: 15000,
      label: "selector measurement",
    });
    if (!measured) {
      return { clip: null, warning: null, notFound: `Selector not found: ${snippet.selector}` };
    }
    if (measured.width < 1 || measured.height < 1) {
      return {
        clip: null,
        warning: null,
        notFound: `Element found but has zero size: ${snippet.selector}`,
      };
    }
    return {
      clip: {
        x: measured.x + measured.scrollX,
        y: measured.y + measured.scrollY,
        width: measured.width,
        height: measured.height,
      },
      warning: null,
      notFound: null,
    };
  }

  if (snippet.mode === "rect") {
    return { clip: { ...snippet.rect }, warning: null, notFound: null };
  }

  return {
    clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
    warning: null,
    notFound: null,
  };
}

/**
 * Rect approximatif de la cible, avant tout amorçage : sert à savoir jusqu'où
 * pré-scroller. Ne scrolle pas et ne lève pas.
 */
async function estimateTargetRect(tabId, snippet, viewportWidth, viewportHeight) {
  const selector =
    snippet.mode === "anchor" ? snippet.anchorSelector : snippet.mode === "selector" ? snippet.selector : "";
  if (selector) {
    const measured = await evaluate(
      tabId,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      })()`,
      { label: "approximate rect" }
    ).catch(() => null);
    if (measured && measured.width >= 1 && measured.height >= 1) {
      if (snippet.mode === "anchor") {
        return {
          x: measured.x + snippet.offset.dx,
          y: measured.y + snippet.offset.dy,
          width: snippet.offset.width,
          height: snippet.offset.height,
        };
      }
      return measured;
    }
    return { ...snippet.rect };
  }
  if (snippet.mode === "rect") return { ...snippet.rect };
  return { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
}

/** Arrondit le clip et le borne à la taille du document. */
async function clampClip(tabId, raw) {
  const clip = {
    x: Math.max(0, Math.round(raw.x)),
    y: Math.max(0, Math.round(raw.y)),
    width: Math.max(1, Math.round(raw.width)),
    height: Math.max(1, Math.round(raw.height)),
    scale: 1,
  };
  // Borner le clip au document : un clip qui dépasse produit des bandes vides.
  const docSize = await evaluate(
    tabId,
    `(() => {
      const d = document.documentElement;
      const b = document.body;
      return {
        width: Math.max(d.scrollWidth, b ? b.scrollWidth : 0, d.clientWidth),
        height: Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight),
      };
    })()`,
    { label: "document size" }
  ).catch(() => null);
  if (docSize && docSize.width >= 1 && docSize.height >= 1) {
    clip.x = Math.min(clip.x, Math.max(0, docSize.width - 1));
    clip.y = Math.min(clip.y, Math.max(0, docSize.height - 1));
    clip.width = Math.max(1, Math.min(clip.width, docSize.width - clip.x));
    clip.height = Math.max(1, Math.min(clip.height, docSize.height - clip.y));
  }
  return clip;
}

const formatSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Capture un snippet. Écrit l'image en IndexedDB uniquement en cas de succès :
 * sur erreur ou session expirée, la dernière bonne image est conservée.
 *
 * `hooks.captureWindowId` permet de réutiliser la fenêtre dédiée d'une capture
 * à l'autre ; `hooks.onWindowOpened` la persiste côté service worker pour
 * qu'elle soit refermée même si celui-ci est tué en pleine capture.
 *
 * @returns {Promise<{status: "ok"|"session_expired"|"selector_not_found"|"error",
 *   capturedAt?: number, width?: number, height?: number,
 *   lastError: string|null, warning?: string|null, blankSuspected?: boolean,
 *   lastDiag?: string, windowId?: number|null, lastDurationMs: number,
 *   finalUrl?: string}>}
 */
export async function captureSnippet(snippet, settings, hooks = {}) {
  const startedAt = Date.now();
  // Le viewport par snippet (posé par le picker) primes sur le réglage global :
  // la mise en page doit être celle vue au moment de la sélection.
  const viewportWidth = snippet.viewportWidth > 0 ? snippet.viewportWidth : settings.viewportWidth || 1280;
  const viewportHeight =
    snippet.viewportHeight > 0 ? snippet.viewportHeight : settings.viewportHeight || 800;
  const selectorTimeoutMs = settings.waitSelectorTimeoutMs || 15000;
  const imagesTimeoutMs = Number.isFinite(settings.imagesTimeoutMs)
    ? Math.max(0, settings.imagesTimeoutMs)
    : 6000;
  const warnings = [];
  const diag = [];
  let blankSuspected = false;
  let windowId = typeof hooks.captureWindowId === "number" ? hooks.captureWindowId : null;

  if (!/^https?:\/\//i.test(snippet.url)) {
    return {
      status: "error",
      lastError: "Invalid URL: only http(s) is supported.",
      lastDurationMs: Date.now() - startedAt,
      windowId,
    };
  }

  let tabId = null;
  let keepTab = false;
  try {
    const surface = await openCaptureSurface(settings, windowId, {
      width: viewportWidth,
      height: viewportHeight,
    });
    tabId = surface.tabId;
    windowId = surface.windowId;
    keepTab = surface.keepTab;
    if (surface.warning) warnings.push(surface.warning);
    if (hooks.onTabOpened) await hooks.onTabOpened(tabId);
    if (hooks.onWindowOpened) await hooks.onWindowOpened(windowId);

    await withTimeout(chrome.debugger.attach({ tabId }, CDP_VERSION), 10000, "debugger.attach");
    await send(tabId, "Page.enable");
    await send(tabId, "Runtime.enable");
    await send(tabId, "Network.enable");

    // 1) Émulation de visibilité : posée avant la navigation pour que le
    //    bootstrap tourne avant le premier script de la page.
    await installVisibilityEmulation(tabId);

    let emulatedHeight = viewportHeight;
    await send(tabId, "Emulation.setDeviceMetricsOverride", {
      width: viewportWidth,
      height: emulatedHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 2) Navigation + fin de chargement.
    const loadStartedAt = Date.now();
    const load = onceEvent(tabId, "Page.loadEventFired");
    try {
      const nav = await send(tabId, "Page.navigate", { url: snippet.url });
      if (nav && nav.errorText) throw new Error(`Navigation failed: ${nav.errorText}`);
      try {
        await withTimeout(load.promise, LOAD_TIMEOUT_MS, "Page.loadEventFired");
      } catch (_) {
        // Certaines pages (long-polling, sockets) ne déclenchent jamais "load" :
        // on continue, les attentes suivantes feront foi.
      }
    } finally {
      load.cancel();
    }
    diag.push(`load ${formatSeconds(Date.now() - loadStartedAt)}`);

    // 3) waitForSelector : polling via Runtime.evaluate.
    if (snippet.waitForSelector) {
      const deadline = Date.now() + selectorTimeoutMs;
      let found = false;
      while (Date.now() < deadline) {
        const present = await evaluate(
          tabId,
          `!!document.querySelector(${JSON.stringify(snippet.waitForSelector)})`,
          { label: "waitForSelector" }
        );
        if (present) {
          found = true;
          break;
        }
        await sleep(300);
      }
      if (!found) {
        return {
          status: "error",
          lastError: `Wait selector never appeared (${selectorTimeoutMs} ms): ${snippet.waitForSelector}`,
          lastDurationMs: Date.now() - startedAt,
          windowId,
        };
      }
    }

    // 4) Délai de stabilisation puis gel des animations.
    if (snippet.delayMs > 0) await sleep(snippet.delayMs);

    if (snippet.freezeAnimations) {
      await evaluate(
        tabId,
        `(() => {
          const id = "__lls_freeze__";
          if (!document.getElementById(id)) {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = ${JSON.stringify(FREEZE_CSS)};
            (document.head || document.documentElement).appendChild(style);
          }
          return true;
        })()`,
        { label: "freezeAnimations" }
      );
    }

    // 5) Garde "session expirée".
    const finalUrl = await evaluate(tabId, "location.href", { label: "location.href" });
    const urlLooksLikeLogin =
      typeof finalUrl === "string" && LOGIN_URL_RE.test(finalUrl) && !LOGIN_URL_RE.test(snippet.url);
    let expiredSelectorHit = false;
    if (snippet.expiredSelector) {
      expiredSelectorHit = Boolean(
        await evaluate(tabId, `!!document.querySelector(${JSON.stringify(snippet.expiredSelector)})`, {
          label: "expiredSelector",
        })
      );
    }
    if (urlLooksLikeLogin || expiredSelectorHit) {
      return {
        status: "session_expired",
        finalUrl: typeof finalUrl === "string" ? finalUrl : undefined,
        lastError: urlLooksLikeLogin
          ? `Redirected to a sign-in page: ${finalUrl}`
          : `Session-expired marker found: ${snippet.expiredSelector}`,
        lastDurationMs: Date.now() - startedAt,
        windowId,
      };
    }

    // 6) Amorçage du lazy-loading, sur un rect approximatif (la mesure exacte
    //    vient après, car le pré-scroll peut déplacer la mise en page).
    const primeOptions = { imagesTimeoutMs, scrollPrime: snippet.scrollPrime !== false };
    const estimated = await estimateTargetRect(tabId, snippet, viewportWidth, viewportHeight);
    const primeStartedAt = Date.now();
    await primeLazyContent(tabId, estimated, primeOptions);
    diag.push(`prime ${formatSeconds(Date.now() - primeStartedAt)}`);

    // 7) Rect à capturer, en coordonnées de page (captureBeyondViewport).
    const measured = await measureTarget(tabId, snippet, viewportWidth, viewportHeight);
    if (measured.notFound) {
      return {
        status: "selector_not_found",
        lastError: measured.notFound,
        lastDurationMs: Date.now() - startedAt,
        windowId,
      };
    }
    if (measured.warning) warnings.push(measured.warning);
    let clip = await clampClip(tabId, measured.clip);

    // 8) Viewport couvrant la cible : sous le pli, du contenu jamais peint
    //    ressort vide même avec captureBeyondViewport.
    if (clip.y + clip.height > emulatedHeight) {
      emulatedHeight = Math.min(clip.y + clip.height + 100, MAX_EMULATED_HEIGHT);
      await send(tabId, "Emulation.setDeviceMetricsOverride", {
        width: viewportWidth,
        height: emulatedHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(tabId, AWAIT_FRAME_JS, {
        awaitPromise: true,
        timeoutMs: 5000,
        label: "frame after viewport extension",
      }).catch(() => {});
      await sleep(300);
      // La mise en page a pu bouger : on remesure avant de capturer.
      const again = await measureTarget(tabId, snippet, viewportWidth, viewportHeight);
      if (again.clip) clip = await clampClip(tabId, again.clip);
    }
    diag.push(`viewport ${viewportWidth}×${emulatedHeight}`);

    // 9) Screenshot, avec une seconde tentative si l'image sort uniforme.
    const shoot = async () => {
      const shot = await withTimeout(
        send(tabId, "Page.captureScreenshot", {
          format: "webp",
          quality: 80,
          clip,
          captureBeyondViewport: true,
        }),
        30000,
        "Page.captureScreenshot"
      );
      if (!shot || !shot.data) throw new Error("Browser returned an empty capture");
      return base64ToBlob(shot.data, "image/webp");
    };

    let blob = await shoot();
    let analysis = await analyzeBlankness(blob);
    if (analysis && analysis.blank) {
      // Rendu probablement jamais peint : on laisse du temps, on réamorce,
      // et on ne retente qu'une fois.
      await sleep(BLANK_RETRY_WAIT_MS);
      await primeLazyContent(tabId, clip, primeOptions);
      blob = await shoot();
      analysis = await analyzeBlankness(blob);
      diag.push("blank retry");
    }
    if (analysis && analysis.blank) {
      blankSuspected = true;
      warnings.push("Probably blank render (background page?)");
    }

    const capturedAt = Date.now();
    await putImage(snippet.id, {
      blob,
      capturedAt,
      width: clip.width,
      height: clip.height,
    });

    const warning = warnings.length ? warnings.join(" · ") : null;
    return {
      status: "ok",
      capturedAt,
      width: clip.width,
      height: clip.height,
      lastError: warning,
      warning,
      blankSuspected,
      lastDiag: diag.join(" · "),
      lastDurationMs: capturedAt - startedAt,
      finalUrl: typeof finalUrl === "string" ? finalUrl : undefined,
      windowId,
    };
  } catch (error) {
    return {
      status: "error",
      lastError: error && error.message ? error.message : String(error),
      lastDiag: diag.join(" · "),
      lastDurationMs: Date.now() - startedAt,
      windowId,
    };
  } finally {
    // Jamais d'onglet orphelin ni de debugger attaché. La fenêtre dédiée, elle,
    // est réutilisée par la capture suivante : c'est le service worker qui la
    // ferme quand la file est vide.
    await teardownCaptureTab(tabId, keepTab);
  }
}
