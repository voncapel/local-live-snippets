// Injecté par chrome.scripting.executeScript (monde isolé, script classique).
// Sélection d'une zone au cliquer-glisser : rectangle redimensionnable et
// déplaçable, puis calcul d'un élément d'ancrage et d'un offset relatif.
// Idempotent : une ré-injection réarme la session au lieu de dupliquer l'overlay.

(() => {
  const NS = "__localLiveSnippetsPicker__";

  if (window[NS] && typeof window[NS].restart === "function") {
    window[NS].restart();
    return;
  }

  const ROOT_ID = "__lls_picker_root__";
  const MIN_SIZE = 10;
  const Z = "2147483647";
  // Classes générées (CSS-in-JS, hashs) : inutilisables comme ancrage stable.
  const HASHED_CLASS_RE = /^(css|sc|jsx|emotion|styled|makeStyles|tw)[-_]/i;
  const RANDOMISH_RE = /[0-9a-f]{5,}/i;
  const DIGIT_RUN_RE = /\d{3,}/;

  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const HANDLE_CURSORS = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
  };

  let active = false;
  let root = null;
  let veil = null;
  let banner = null;
  let box = null;
  let sizeLabel = null;
  let toolbar = null;
  let anchorLabel = null;
  let validateBtn = null;
  let handleNodes = new Map();

  /** Rectangle courant en coordonnées de PAGE (client + scroll), ou null. */
  let rect = null;
  /** { kind: "draw"|"move"|"resize", handle?, originX, originY, startRect } */
  let drag = null;
  /** Drapeaux posés sur `window` juste avant l'injection du fichier. */
  let pendingFlags = { snippetId: null, openedByOptions: false };

  /* ---------------------------- sélecteur CSS ---------------------------- */

  function isStableClass(cls) {
    if (!cls || cls.length > 60) return false;
    if (HASHED_CLASS_RE.test(cls)) return false;
    if (RANDOMISH_RE.test(cls)) return false;
    if (DIGIT_RUN_RE.test(cls)) return false;
    return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(cls);
  }

  function isUsableId(id) {
    if (!id) return false;
    // Un id purement numérique (ou commençant par un chiffre) n'est pas un
    // sélecteur CSS valide sans échappement, et sent l'id généré.
    if (/^\d/.test(id)) return false;
    if (RANDOMISH_RE.test(id) && DIGIT_RUN_RE.test(id)) return false;
    return /^[A-Za-z_][A-Za-z0-9_\-:.]*$/.test(id);
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (_) {
      return false;
    }
  }

  function stableClasses(element) {
    const list = element.classList ? Array.from(element.classList) : [];
    return list.filter(isStableClass).slice(0, 3);
  }

  /** Sélecteur d'un seul niveau : tag + classes stables + nth-of-type si besoin. */
  function localSelector(element, withNth) {
    const tag = element.localName;
    const classes = stableClasses(element);
    let selector = tag + classes.map((c) => `.${CSS.escape(c)}`).join("");
    if (withNth) {
      const parent = element.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.localName === tag);
        if (sameTag.length > 1) selector += `:nth-of-type(${sameTag.indexOf(element) + 1})`;
      }
    }
    return selector;
  }

  function buildSelector(element) {
    if (!element || element.nodeType !== 1) return "";
    if (element === document.body) return "body";
    if (element === document.documentElement) return "html";

    if (isUsableId(element.id)) {
      const byId = `#${CSS.escape(element.id)}`;
      if (isUnique(byId)) return byId;
    }

    // On remonte l'arbre en empilant les niveaux jusqu'à obtenir l'unicité.
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (isUsableId(node.id)) {
        const anchored = [`#${CSS.escape(node.id)}`, ...parts].join(" > ");
        if (isUnique(anchored)) return anchored;
      }
      parts.unshift(localSelector(node, true));
      const candidate = parts.join(" > ");
      if (isUnique(candidate)) return candidate;
      if (parts.length >= 8) break;
      node = node.parentElement;
    }

    const fallback = parts.join(" > ");
    if (fallback && isUnique(fallback)) return fallback;

    // Dernier recours : chemin complet depuis <html> (toujours unique).
    const full = [];
    let cursor = element;
    while (cursor && cursor.nodeType === 1) {
      full.unshift(localSelector(cursor, true));
      if (cursor === document.documentElement) break;
      cursor = cursor.parentElement;
    }
    return full.join(" > ") || fallback || element.localName;
  }

  /* ------------------------------- ancrage ------------------------------- */

  /** Élément sous (x, y) en coordonnées client, overlay masqué le temps du test. */
  function elementUnder(clientX, clientY) {
    const previous = root ? root.style.display : null;
    if (root) root.style.display = "none";
    let element = null;
    try {
      element = document.elementFromPoint(clientX, clientY);
    } catch (_) {
      element = null;
    }
    if (root && previous !== null) root.style.display = previous;
    return element;
  }

  /**
   * Plus petit élément dont le rect contient entièrement le rectangle demandé.
   * On part du centre (ramené dans le viewport) et on remonte les parents.
   */
  function findAnchor(pageRect) {
    const clientRect = {
      left: pageRect.x - window.scrollX,
      top: pageRect.y - window.scrollY,
      right: pageRect.x + pageRect.width - window.scrollX,
      bottom: pageRect.y + pageRect.height - window.scrollY,
    };
    const probeX = Math.min(window.innerWidth - 2, Math.max(1, (clientRect.left + clientRect.right) / 2));
    const probeY = Math.min(window.innerHeight - 2, Math.max(1, (clientRect.top + clientRect.bottom) / 2));

    let node = elementUnder(probeX, probeY);
    while (node && node.nodeType === 1) {
      if (node !== root && !root.contains(node)) {
        const r = node.getBoundingClientRect();
        const contains =
          r.left <= clientRect.left + 1 &&
          r.top <= clientRect.top + 1 &&
          r.right >= clientRect.right - 1 &&
          r.bottom >= clientRect.bottom - 1;
        if (contains && r.width >= 1 && r.height >= 1) return node;
      }
      node = node.parentElement;
    }
    return document.body || document.documentElement;
  }

  /* -------------------------------- overlay -------------------------------- */

  function css(node, declarations) {
    node.style.cssText = declarations.join(";");
  }

  function makeButton(label, primary) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.dataset.llsUi = "1";
    css(btn, [
      "all:unset",
      "box-sizing:border-box",
      "display:inline-block",
      "padding:5px 12px",
      "border-radius:7px",
      "font:600 12px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif",
      "cursor:pointer",
      primary ? "background:#2563eb" : "background:#374151",
      "color:#ffffff",
      "border:1px solid rgba(255,255,255,0.14)",
    ]);
    return btn;
  }

  function buildOverlay() {
    root = document.createElement("div");
    root.id = ROOT_ID;
    css(root, [
      "position:fixed",
      "inset:0",
      `z-index:${Z}`,
      "margin:0",
      "padding:0",
      "cursor:crosshair",
      "user-select:none",
      "-webkit-user-select:none",
      "touch-action:none",
      "contain:layout style",
    ]);

    veil = document.createElement("div");
    css(veil, ["position:absolute", "inset:0", "background:rgba(15,23,42,0.45)"]);

    banner = document.createElement("div");
    banner.textContent = "Dessinez un rectangle · Entrée pour valider · Échap pour annuler";
    css(banner, [
      "position:absolute",
      "top:14px",
      "left:50%",
      "transform:translateX(-50%)",
      "max-width:90vw",
      "padding:8px 16px",
      "border-radius:999px",
      "background:#0f172a",
      "color:#f8fafc",
      "font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif",
      "box-shadow:0 6px 20px rgba(0,0,0,0.4)",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "pointer-events:none",
    ]);

    box = document.createElement("div");
    css(box, [
      "position:absolute",
      "box-sizing:border-box",
      "border:1px solid #60a5fa",
      "outline:1px solid rgba(15,23,42,0.6)",
      "box-shadow:0 0 0 100vmax rgba(15,23,42,0.45)",
      "cursor:move",
      "display:none",
    ]);

    sizeLabel = document.createElement("div");
    css(sizeLabel, [
      "position:absolute",
      "padding:2px 7px",
      "border-radius:5px",
      "background:#0f172a",
      "color:#f8fafc",
      "font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:nowrap",
      "pointer-events:none",
      "display:none",
    ]);

    toolbar = document.createElement("div");
    toolbar.dataset.llsUi = "1";
    css(toolbar, [
      "position:absolute",
      "display:none",
      "align-items:center",
      "gap:8px",
      "max-width:min(560px,92vw)",
      "padding:7px 9px",
      "border-radius:10px",
      "background:#111827",
      "box-shadow:0 8px 24px rgba(0,0,0,0.45)",
      "cursor:default",
    ]);

    anchorLabel = document.createElement("span");
    css(anchorLabel, [
      "flex:1 1 auto",
      "min-width:0",
      "max-width:300px",
      "color:#cbd5e1",
      "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      "pointer-events:none",
    ]);

    validateBtn = makeButton("Valider", true);
    const cancelBtn = makeButton("Annuler", false);
    validateBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      confirmSelection();
    });
    cancelBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    });
    toolbar.append(anchorLabel, validateBtn, cancelBtn);

    handleNodes = new Map();
    for (const name of HANDLES) {
      const handle = document.createElement("div");
      handle.dataset.llsHandle = name;
      css(handle, [
        "position:absolute",
        "width:11px",
        "height:11px",
        "box-sizing:border-box",
        "border:1px solid #1e3a8a",
        "border-radius:3px",
        "background:#f8fafc",
        `cursor:${HANDLE_CURSORS[name]}`,
      ]);
      handleNodes.set(name, handle);
      box.appendChild(handle);
    }

    root.append(veil, box, sizeLabel, toolbar, banner);
    (document.body || document.documentElement).appendChild(root);
  }

  /** Positionne box, poignées, étiquette et barre d'outils depuis `rect`. */
  function layout() {
    if (!root) return;
    if (!rect) {
      veil.style.display = "block";
      box.style.display = "none";
      sizeLabel.style.display = "none";
      toolbar.style.display = "none";
      return;
    }

    const left = rect.x - window.scrollX;
    const top = rect.y - window.scrollY;
    veil.style.display = "none";
    box.style.display = "block";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    for (const [name, handle] of handleNodes) {
      const x = name.includes("w") ? 0 : name.includes("e") ? rect.width : rect.width / 2;
      const y = name.includes("n") ? 0 : name.includes("s") ? rect.height : rect.height / 2;
      handle.style.left = `${x - 6}px`;
      handle.style.top = `${y - 6}px`;
    }

    sizeLabel.style.display = "block";
    sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    const labelTop = top > 26 ? top - 22 : top + 6;
    sizeLabel.style.left = `${Math.max(4, Math.min(left, window.innerWidth - 120))}px`;
    sizeLabel.style.top = `${Math.max(4, labelTop)}px`;

    toolbar.style.display = drag ? "none" : "flex";
    const barTop = top + rect.height + 10;
    toolbar.style.left = `${Math.max(4, Math.min(left, window.innerWidth - 320))}px`;
    toolbar.style.top = `${barTop + 46 < window.innerHeight ? barTop : Math.max(4, top - 52)}px`;

    const big = rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
    validateBtn.style.opacity = big ? "1" : "0.45";
    validateBtn.style.pointerEvents = big ? "auto" : "none";
  }

  function refreshAnchorLabel() {
    if (!rect || !anchorLabel) return;
    const anchor = findAnchor(rect);
    anchorLabel.textContent = anchor ? `Ancre : ${buildSelector(anchor)}` : "Ancre : body";
  }

  /* ------------------------------ interactions ------------------------------ */

  function normalizeRect(r) {
    return {
      x: Math.round(Math.max(0, Math.min(r.x, r.x + r.width))),
      y: Math.round(Math.max(0, Math.min(r.y, r.y + r.height))),
      width: Math.round(Math.abs(r.width)),
      height: Math.round(Math.abs(r.height)),
    };
  }

  function onPointerDown(event) {
    if (!active || event.button !== 0) return;
    const target = event.target;

    // Les boutons de la barre d'outils gardent leur comportement natif.
    if (target && target.closest && target.closest("[data-lls-ui]")) return;

    event.preventDefault();
    event.stopPropagation();

    const pageX = event.clientX + window.scrollX;
    const pageY = event.clientY + window.scrollY;
    const handle = target && target.dataset ? target.dataset.llsHandle : null;

    if (handle && rect) {
      drag = { kind: "resize", handle, originX: pageX, originY: pageY, startRect: { ...rect } };
    } else if (rect && target === box) {
      drag = { kind: "move", originX: pageX, originY: pageY, startRect: { ...rect } };
    } else {
      rect = { x: pageX, y: pageY, width: 0, height: 0 };
      drag = { kind: "draw", originX: pageX, originY: pageY, startRect: { ...rect } };
    }

    try {
      root.setPointerCapture(event.pointerId);
    } catch (_) {
      // Navigateur sans capture de pointeur sur cet élément : les listeners
      // document suffisent.
    }
    layout();
  }

  function onPointerMove(event) {
    if (!active || !drag) return;
    event.preventDefault();
    const pageX = event.clientX + window.scrollX;
    const pageY = event.clientY + window.scrollY;
    const dx = pageX - drag.originX;
    const dy = pageY - drag.originY;
    const start = drag.startRect;

    if (drag.kind === "draw") {
      rect = normalizeRect({ x: start.x, y: start.y, width: dx, height: dy });
    } else if (drag.kind === "move") {
      rect = { ...start, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) };
    } else {
      let { x, y, width, height } = start;
      if (drag.handle.includes("w")) {
        x = start.x + dx;
        width = start.width - dx;
      }
      if (drag.handle.includes("e")) width = start.width + dx;
      if (drag.handle.includes("n")) {
        y = start.y + dy;
        height = start.height - dy;
      }
      if (drag.handle.includes("s")) height = start.height + dy;
      rect = normalizeRect({ x, y, width, height });
    }
    layout();
  }

  function onPointerUp(event) {
    if (!active || !drag) return;
    event.preventDefault();
    try {
      root.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* capture déjà relâchée */
    }
    const wasDraw = drag.kind === "draw";
    drag = null;

    // Un simple clic sans glisser ne vaut pas sélection.
    if (wasDraw && rect && (rect.width < MIN_SIZE || rect.height < MIN_SIZE)) rect = null;

    layout();
    if (rect) refreshAnchorLabel();
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      confirmSelection();
    }
  }

  function onScrollOrResize() {
    if (active) layout();
  }

  /* -------------------------------- résultat -------------------------------- */

  function confirmSelection() {
    if (!rect || rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;

    const anchor = findAnchor(rect);
    const anchorSelector = anchor ? buildSelector(anchor) : "body";
    const anchorRect = anchor ? anchor.getBoundingClientRect() : { left: 0, top: 0 };
    const anchorPageX = anchorRect.left + window.scrollX;
    const anchorPageY = anchorRect.top + window.scrollY;

    finish({
      anchorSelector,
      offset: {
        dx: Math.round(rect.x - anchorPageX),
        dy: Math.round(rect.y - anchorPageY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      rect: { ...rect },
    });
  }

  function readInjectedFlags() {
    const snippetId = typeof window.__llsPickerTargetId === "string" ? window.__llsPickerTargetId : null;
    const openedByOptions = window.__llsPickerOpenedByOptions === true;
    try {
      delete window.__llsPickerTargetId;
      delete window.__llsPickerOpenedByOptions;
    } catch (_) {
      window.__llsPickerTargetId = undefined;
      window.__llsPickerOpenedByOptions = undefined;
    }
    return { snippetId, openedByOptions };
  }

  /** Envoie le résultat (ou l'annulation) au service worker, puis démonte tout. */
  function finish(selection) {
    if (!active) return;
    const flags = pendingFlags;
    const payload = {
      type: "pickerResult",
      snippetId: flags.snippetId,
      openedByOptions: flags.openedByOptions,
      url: location.href,
      title: document.title || location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
      anchorSelector: selection ? selection.anchorSelector : null,
      // `selector` reste renseigné : le service worker s'en sert comme garde.
      selector: selection ? selection.anchorSelector : null,
      offset: selection ? selection.offset : null,
      rect: selection ? selection.rect : null,
    };

    teardown();

    try {
      // Aucun récepteur garanti : la promesse peut rejeter.
      const sent = chrome.runtime.sendMessage(payload);
      if (sent && typeof sent.catch === "function") sent.catch(() => {});
    } catch (_) {
      // L'extension a été rechargée : rien à faire de plus ici.
    }
  }

  /* --------------------------- cycle de vie --------------------------- */

  function addListeners() {
    root.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectstart", preventDefault, true);
    document.addEventListener("dragstart", preventDefault, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize, true);
  }

  function removeListeners() {
    if (root) root.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerUp, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("selectstart", preventDefault, true);
    document.removeEventListener("dragstart", preventDefault, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize, true);
  }

  function preventDefault(event) {
    if (active && drag) event.preventDefault();
  }

  function teardown() {
    active = false;
    drag = null;
    rect = null;
    removeListeners();
    if (root && root.isConnected) root.remove();
    const stray = document.getElementById(ROOT_ID);
    if (stray) stray.remove();
    root = null;
    veil = null;
    banner = null;
    box = null;
    sizeLabel = null;
    toolbar = null;
    anchorLabel = null;
    validateBtn = null;
    handleNodes = new Map();
  }

  function start() {
    if (active) return;
    pendingFlags = readInjectedFlags();
    active = true;
    rect = null;
    drag = null;
    buildOverlay();
    addListeners();
    layout();
  }

  window[NS] = {
    start,
    restart() {
      teardown();
      start();
    },
    stop: teardown,
  };

  start();
})();
