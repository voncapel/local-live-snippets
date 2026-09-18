# Privacy Policy for Boardmine

**Last Updated**: September 18, 2026

Boardmine ("we", "our", or "the extension") is a Google Chrome extension designed with a strict **local-first and privacy-by-design** architecture. 

Your privacy is paramount. We believe your dashboard, browsing habits, and monitoring feeds are strictly your own business.

---

## 1. Zero Data Collection & Telemetry

- **No Remote Servers**: Boardmine does not operate any backend server, database, or cloud infrastructure.
- **No Analytics or Tracking**: We do not collect, store, transmit, or analyze any telemetry, usage metrics, crash reports, or analytics data.
- **No Third-Party Sharing**: We do not share, sell, rent, or monetize any user data under any circumstances.

---

## 2. Where Your Data is Stored

All data generated while using Boardmine remains strictly on your local device:

- **Visual Captures**: Screenshots of clipped page elements are stored locally in your browser's **IndexedDB**.
- **Configurations**: Board structures, snippet settings, URLs, refresh intervals, and coordinates are stored locally in Chrome's **chrome.storage.local**.
- **Ephemeral State**: Refresh queues and background job status are kept in memory or **chrome.storage.session**.

When you uninstall the extension, all locally stored data, snippets, and images are completely deleted by your browser.

---

## 3. Browser Permissions & How They Are Used

Boardmine requests specific browser permissions solely to deliver its visual monitoring functionality:

- **`<all_urls>`**: Enables you to select and visually monitor elements on any website of your choosing.
- **`debugger`**: Enables Chrome DevTools Protocol (CDP) to take accurate visual snapshots of background tabs with custom clipping and viewport emulation. Detaches immediately once the capture completes.
- **`storage` & `unlimitedStorage`**: Allows storing snippet metadata and captured images locally in your browser.
- **`alarms`**: Powers the background timer that triggers periodic refreshes based on your customized intervals.
- **`tabs`**: Interacts with the active tab to start visual selection and to open the target website when you click a card.
- **`scripting`**: Injects the drag-and-drop selector overlay into the webpage you choose to clip.
- **`favicon`**: Displays the favicon of clipped websites in the board card headers.

---

## 4. Session & Cookie Awareness

Boardmine operates within your existing Chrome browser profile. This enables it to refresh snapshots of sites where you are already logged in (e.g. internal company tools, private dashboards). 

At no point does Boardmine read, export, or transmit your passwords, cookies, authentication tokens, or session headers to any third party. All network requests stay strictly between your browser and the origin server of the site you choose to monitor.

---

## 5. Contact & Questions

If you have any questions or feedback regarding this Privacy Policy or Boardmine's security practices, please contact:

- **Developer**: Tristan Chapelle
- **Email**: contact@adoptionlayer.com
- **Website**: https://adoptionlayer.com
