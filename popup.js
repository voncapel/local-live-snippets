// Popup : choix rapide du board cible (liste cliquable), capture d'une zone,
// « Capture all ». La liste des snippets vit dans Settings et sur les boards.

import { getBoards, getSnippets, getUi, patchUi, resolveNewTabBoardId } from "./storage.js";

const boardListEl = document.getElementById("board-list");
const countEl = document.getElementById("count");

// Board cible de la prochaine capture. Résolu au premier rendu, puis piloté par
// la liste ; `ui.lastBoardId` est écrit immédiatement à chaque changement.
let targetBoardId = null;
// Écriture en cours de `ui.lastBoardId` : attendue avant l'injection du picker,
// car c'est le service worker qui relit la valeur au `pickerResult`.
let pendingBoardWrite = Promise.resolve();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Ouvre la page de board dédiée (URL stable `newtab.html?board=<id>`). */
function openBoard(boardId) {
  const url = `${chrome.runtime.getURL("newtab.html")}?board=${encodeURIComponent(boardId)}`;
  chrome.tabs.create({ url, active: true });
}

/**
 * Board présélectionné : `ui.lastBoardId` s'il pointe encore sur un board
 * existant, sinon le board du Nouvel Onglet.
 */
async function resolveTargetBoardId(boards) {
  const ui = await getUi();
  const wanted = String(ui.lastBoardId || "");
  if (wanted && boards.some((b) => b.id === wanted)) return wanted;
  return resolveNewTabBoardId();
}

function selectBoard(boardId) {
  targetBoardId = boardId;
  for (const row of boardListEl.children) {
    row.setAttribute("aria-checked", String(row.dataset.id === boardId));
  }
  pendingBoardWrite = patchUi({ lastBoardId: boardId });
  pendingBoardWrite.catch((error) => console.warn("[Boardmine] popup lastBoardId", error));
}

function boardRow(board, snippetCount, isNewTab) {
  const li = el("li", "board-row");
  li.dataset.id = board.id;
  li.setAttribute("role", "radio");
  li.setAttribute("aria-checked", String(board.id === targetBoardId));
  li.tabIndex = 0;

  const main = el("div", "board-main");
  const nameLine = el("div", "board-name-line");
  nameLine.appendChild(el("span", "board-name", board.name));
  if (isNewTab) nameLine.appendChild(el("span", "board-tag", "New Tab"));
  main.appendChild(nameLine);
  main.appendChild(
    el("div", "board-count", snippetCount === 1 ? "1 snippet" : `${snippetCount} snippets`)
  );
  li.appendChild(main);

  const openBtn = el("button", "icon-btn", "↗");
  openBtn.type = "button";
  openBtn.title = "Open board in a new tab";
  openBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openBoard(board.id);
  });
  li.appendChild(openBtn);

  li.addEventListener("click", () => selectBoard(board.id));
  li.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectBoard(board.id);
    }
  });
  return li;
}

async function render() {
  const [boards, snippets, newTabBoardId] = await Promise.all([
    getBoards(),
    getSnippets(),
    resolveNewTabBoardId(),
  ]);

  if (!targetBoardId || !boards.some((b) => b.id === targetBoardId)) {
    targetBoardId = await resolveTargetBoardId(boards);
  }

  countEl.textContent = snippets.length ? `${snippets.length} snippet(s)` : "";

  boardListEl.replaceChildren();
  for (const board of boards) {
    const count = snippets.filter((s) => s.boardId === board.id).length;
    boardListEl.appendChild(boardRow(board, count, board.id === newTabBoardId));
  }
}

const pickErrorEl = document.getElementById("pick-error");

function showPickError(text) {
  pickErrorEl.textContent = text;
  pickErrorEl.hidden = false;
}

// Le popup se ferme dès que la page reprend le focus : c'est le service worker
// qui traite le message `pickerResult`, pas cette page.
document.getElementById("pick-zone").addEventListener("click", async () => {
  pickErrorEl.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showPickError("No active tab.");
      return;
    }
    if (!/^https?:\/\//i.test(tab.url || "")) {
      showPickError(
        "This page cannot be captured: chrome:// pages, the Chrome Web Store and PDFs are not supported."
      );
      return;
    }
    // Le board cible doit être persisté avant l'injection : le popup se ferme
    // juste après et le SW lira `ui.lastBoardId` au `pickerResult`.
    await pendingBoardWrite;
    if (targetBoardId) await patchUi({ lastBoardId: targetBoardId });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    window.close();
  } catch (error) {
    showPickError(`Injection failed: ${error && error.message ? error.message : String(error)}`);
  }
});

document.getElementById("capture-all").addEventListener("click", async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: "captureAll" });
  setTimeout(() => {
    btn.disabled = false;
  }, 1500);
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.snippets || changes.boards || changes.settings) {
    render().catch((error) => console.warn("[Boardmine] popup", error));
  }
});

await render();
