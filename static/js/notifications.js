const DB_NAME = "notionless";
const DB_VERSION = 2;
const STORE_NAME = "notifications";
const STATE_STORE = "state";

let db = null;

async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { db = request.result; resolve(db); };
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, { keyPath: "key" });
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

window.notifications = { addNotification, getNotifications, clearNotifications, trimNotifications, saveState, getState };
