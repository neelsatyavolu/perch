/** Hands a finished screenshot from the service worker to the markup page through IndexedDB. */

export type Shot = { blob: Blob; title: string; url: string; truncated: boolean; created: number };

const DB = "perch-shots";
const STORE = "shots";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB could not be opened"));
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

export async function putShot(shot: Shot): Promise<string> {
  const id = crypto.randomUUID();
  await run("readwrite", (s) => s.put(shot, id));
  return id;
}

/** Reads and deletes: a screenshot is kept only until its page has it. */
export async function takeShot(id: string): Promise<Shot | null> {
  const shot = await run<Shot | undefined>("readonly", (s) => s.get(id));
  await run("readwrite", (s) => s.delete(id));
  return shot ?? null;
}
