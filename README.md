# Local Live Snippets

Chrome extension (Manifest V3) that periodically screenshots **zones of web pages** — dashboards, feeds, anything behind a login — and shows them, always fresh, on your **New Tab page**. A local clone of Arc's "Live Previews".

- 100 % local: no server, no telemetry, no npm, no build step.
- Captures run in a real tab of your Chrome profile, so your existing sessions/cookies are reused.
- UI is in French.

![New Tab with two live snippets](docs/screenshot.png)

## Install

1. Clone or download this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `local-live-snippets` folder.
5. Open a new tab: the extension replaces the New Tab page.

## Use

1. Go to the page you want to watch (log in first if needed).
2. Click the extension icon → **Capturer une zone de cette page**.
3. Drag a rectangle over the zone. Adjust it with the handles, then press **Enter** (Esc cancels).

A snippet is created, captured immediately, and a new tab opens with your grid.

On the New Tab page:

- Drag a card by its header, resize it with the bottom-right handle. Layout is saved.
- **⤢** toggles fit/fill. **↻** recaptures now. **⋯** → redefine zone, rename, interval, delete.
- Click the image to open the source page.

Default refresh interval is 15 minutes (per snippet, editable in **Paramètres**).

## About the "debugging this browser" bar

Every capture shows this bar for a few seconds:

> *Une extension a commencé à déboguer ce navigateur* / *"Local Live Snippets" started debugging this browser*

This is expected. The extension uses `chrome.debugger` (Chrome DevTools Protocol) because it is the only API that can screenshot a **background** tab with a precise clip and a forced viewport. Nothing is sent anywhere. The bar disappears when the capture ends.

If you click **Cancel** on that bar, the current capture is aborted cleanly and the queue continues.

To hide the bar permanently, launch Chrome with:

```
--silent-debugger-extension-api
```

(macOS: `open -a "Google Chrome" --args --silent-debugger-extension-api`). This flag only silences the warning UI; it does not change what the extension can do.

## Black or empty captures

If a snippet comes out black or with grey placeholders (X/Twitter, lazy-loaded galleries…), the page refused to render in a background tab. The extension already fakes visibility and pre-scrolls to trigger lazy loading; if that is not enough:

1. **Paramètres → Utiliser une fenêtre de capture dédiée**. Captures then run in a small unfocused popup window whose tab is really "visible" to Chrome. It appears briefly behind your current window and closes when the queue is empty.
2. Per snippet: raise **Délai après chargement**, or set **Attendre ce sélecteur** to an element that only exists once the data is loaded.
3. On infinite feeds, uncheck **Pré-scroller la page** for that snippet.

Hover the status in Paramètres or the popup to see a short diagnostic of the last capture.

## How it works

For each snippet, one at a time: open a pinned muted tab (or the dedicated window) → attach `chrome.debugger` → emulate a fixed viewport (the one you had when drawing the zone) → navigate → wait for load / selector / delay → detect login redirects (keeps the last good image if the session expired) → prime lazy content → measure the anchor element + offset → `Page.captureScreenshot` (WebP) → detach and close the tab, always in a `finally`.

Images live in IndexedDB, config in `chrome.storage.local`, the capture queue in `chrome.storage.session` so it survives service-worker restarts.

## Limits

- A pinned tab (or the popup window) flashes briefly during each capture.
- Sessions requiring 2FA must be re-authenticated by hand; the extension keeps the last image and shows a reconnect button.
- Captures are stored unencrypted in your Chrome profile.
- `chrome://` pages, the Web Store and PDFs cannot be captured.

## Files

```
manifest.json   MV3 manifest
background.js   service worker: alarm, persisted queue, picker results
capture.js      CDP capture pipeline
picker.js       injected drag-to-select overlay
newtab.*        New Tab page (free grid: drag, resize, menus)
options.*       settings, snippet editor, import/export
popup.*         toolbar popup
storage.js      config helpers    db.js  IndexedDB helpers
```

MIT license.
