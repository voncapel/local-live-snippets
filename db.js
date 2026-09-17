// IndexedDB : stockage des images (Blob WebP) par snippetId.
// Utilisé à la fois par le service worker et les pages.

const DB_NAME = "lls";
const DB_VERSION = 1;
const STORE = "images";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
          const req = fn(store);
          if (req) {
            req.onsuccess = () => {
              result = req.result;
            };
          }
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("IndexedDB transaction aborted"));
      })
  );
}

/** @param {string} id @param {{blob: Blob, capturedAt: number, width: number, height: number}} record */
export function putImage(id, record) {
  return tx("readwrite", (store) => store.put(record, id));
}

/** @returns {Promise<{blob: Blob, capturedAt: number, width: number, height: number}|undefined>} */
export function getImage(id) {
  return tx("readonly", (store) => store.get(id));
}

/** @returns {Promise<Map<string, object>>} */
export async function getAllImages() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const store = t.objectStore(STORE);
    const out = new Map();
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.set(cursor.key, cursor.value);
        cursor.continue();
      }
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

export function deleteImage(id) {
  return tx("readwrite", (store) => store.delete(id));
}

export function clearImages() {
  return tx("readwrite", (store) => store.clear());
}
