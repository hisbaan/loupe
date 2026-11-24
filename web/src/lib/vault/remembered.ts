// The unlocked vault key, remembered in IndexedDB so page loads on this computer
// don't lock the vault again. IndexedDB stores the CryptoKey itself; it's
// forgotten on lock, sign-out, a page load without a session, or when it no
// longer opens the vault.

const DB = "loupe-vault"
const STORE = "keys"
const VAULT_KEY = "vault"

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = op(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

/** Remembering is best-effort: without IndexedDB the vault just locks on reload. */
export async function rememberKey(key: CryptoKey) {
  await run("readwrite", (store) => store.put(key, VAULT_KEY)).catch(() => {})
}

export async function recallKey(): Promise<CryptoKey | null> {
  const key = await run<unknown>("readonly", (store) => store.get(VAULT_KEY)).catch(() => null)
  return key instanceof CryptoKey ? key : null
}

export async function forgetKey() {
  await run("readwrite", (store) => store.delete(VAULT_KEY)).catch(() => {})
}
