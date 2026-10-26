import type { ChatQueueItem } from "./ui-types.ts";

const DB_NAME = "openclaw-ui";
const DB_VERSION = 1;
const STORE_NAME = "chat_queue";

type StoredQueueItem = ChatQueueItem & { id: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

export async function saveQueueItem(item: StoredQueueItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(item);
    tx.addEventListener("complete", () => {
      db.close();
      resolve();
    });
    tx.addEventListener("error", () => {
      db.close();
      reject(tx.error);
    });
  });
}

export async function getAllQueueItems(): Promise<StoredQueueItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.addEventListener("success", () => {
      db.close();
      const items = request.result as StoredQueueItem[];
      // Return sorted by creation time so order is preserved
      items.sort((a, b) => a.createdAt - b.createdAt);
      resolve(items);
    });
    request.addEventListener("error", () => {
      db.close();
      reject(request.error);
    });
  });
}

export async function deleteQueueItem(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.addEventListener("complete", () => {
      db.close();
      resolve();
    });
    tx.addEventListener("error", () => {
      db.close();
      reject(tx.error);
    });
  });
}

export async function clearQueue(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.addEventListener("complete", () => {
      db.close();
      resolve();
    });
    tx.addEventListener("error", () => {
      db.close();
      reject(tx.error);
    });
  });
}
