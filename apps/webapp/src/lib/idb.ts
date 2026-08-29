/**
 * The one IndexedDB this app keeps, and the only place its plumbing lives.
 *
 * Three things share it because they share a lifetime: this device's private
 * keys, the ratchet sessions those keys started, and the text of the messages
 * those sessions opened. All three are meaningless without the others, and all
 * three are gone together when somebody clears site data — which is exactly
 * what "sign out of this device" ought to mean.
 *
 * A browser cannot hide any of it from its own page. This is worth what the app
 * lock is worth: it defends against somebody else picking up the laptop, not
 * against code running on the page. Signal Desktop has the same property.
 */

const DB_NAME = 'yappy-keys';

/** Every store the app expects to find. Adding one here is the whole migration. */
export const STORES = {
  /** This device's identity and prekey privates. One record. */
  identity: 'identity',
  /** Ratchet state, keyed by the device at the other end. */
  sessions: 'sessions',
  /** Decrypted message bodies, keyed by message id. */
  plaintext: 'plaintext',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    // Another tab is holding this database open at the old version, so the
    // upgrade cannot run. Failing is the right answer: hanging here would
    // block a send forever, and every caller already treats "no storage" as
    // "cannot encrypt", which is exactly what is true right now.
    request.onblocked = () => reject(new Error('another tab is using the key store'));
  });
}

/**
 * The database, with every store guaranteed.
 *
 * Opened at whatever version exists rather than at a fixed one, because a
 * database can exist without a store inside it — an upgrade interrupted
 * halfway leaves exactly that, and so does adding a store to this file after
 * somebody has already been using the app. Reopening at the same version would
 * never fire `onupgradeneeded` to fix it. Bumping the version does.
 */
export async function openDb(): Promise<IDBDatabase> {
  const db = await openAt();
  const missing = Object.values(STORES).some((store) => !db.objectStoreNames.contains(store));
  if (!missing) return db;
  const version = db.version + 1;
  db.close();
  return openAt(version);
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Everything in one store, for the paths that need the whole set at once. */
export async function idbAll<T>(store: StoreName): Promise<Array<[string, T]>> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly').objectStore(store);
    const keys = tx.getAllKeys();
    const values = tx.getAll();
    tx.transaction.oncomplete = () => {
      const k = (keys.result ?? []) as IDBValidKey[];
      const v = (values.result ?? []) as T[];
      resolve(k.map((key, i) => [String(key), v[i] as T]));
    };
    tx.transaction.onerror = () => resolve([]);
  });
}
