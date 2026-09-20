const DB_NAME = "notionless";
const DB_VERSION = 3;
const STORE_NAME = "notifications";
const STATE_STORE = "state";
const DRAFT_STORE = "drafts";

let db = null;

async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      // Release the connection when a newer version needs to upgrade,
      // otherwise other tabs block the upgrade forever (silent boot hang).
      try {
        db.onversionchange = () => { try { db.close(); } catch {} db = null; };
      } catch {}
      resolve(db);
    };
    request.onblocked = () => {
      console.warn("notionless: IndexedDB upgrade blocked — close other NotionLess tabs, then reload this one.");
    };
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE, { keyPath: "id" });
      }
    };
  });
}

async function saveState(key, value) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STATE_STORE, "readwrite");
    const store = tx.objectStore(STATE_STORE);
    const request = store.put({ key, value });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getState(key) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STATE_STORE, "readonly");
    const store = tx.objectStore(STATE_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result?.value);
    request.onerror = () => reject(request.error);
  });
}

async function addNotification(text, type = "info") {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const entry = { text, type, timestamp: Date.now() };
    const request = store.add(entry);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getNotifications(limit = 50) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result.sort((a, b) => b.timestamp - a.timestamp);
      resolve(all.slice(0, limit));
    };
    request.onerror = () => reject(request.error);
  });
}

async function clearNotifications() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function trimNotifications(keep = 100) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getAll = store.getAll();
    getAll.onsuccess = () => {
      const all = getAll.result.sort((a, b) => b.timestamp - a.timestamp);
      const toDelete = all.slice(keep);
      toDelete.forEach(item => store.delete(item.id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    getAll.onerror = () => reject(getAll.error);
  });
}

// ---- Offline drafts: per-page local truth, zero server cost ----
async function saveDraft(draft) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(DRAFT_STORE, "readwrite");
    const store = tx.objectStore(DRAFT_STORE);
    const request = store.put(draft);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getDraft(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(DRAFT_STORE, "readonly");
    const store = tx.objectStore(DRAFT_STORE);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getAllDrafts() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(DRAFT_STORE, "readonly");
    const store = tx.objectStore(DRAFT_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function deleteDraft(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(DRAFT_STORE, "readwrite");
    const store = tx.objectStore(DRAFT_STORE);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

window.notifications = { addNotification, getNotifications, clearNotifications, trimNotifications, saveState, getState, saveDraft, getDraft, getAllDrafts, deleteDraft };
