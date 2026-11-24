// The inference credential vault: loaded from the server and unlocked with a
// passkey or passphrase. The contents stay decrypted in memory only; the vault
// key is remembered on this computer (`remembered.ts`) until lock or sign-out.

import { useEffect, useSyncExternalStore } from "react"
import { api, type ApiResult } from "@/lib/api"
import type { ChatGptTokens, NewVaultKey, VaultRecord } from "@/lib/types"
import {
  PBKDF2_ITERATIONS,
  decryptJson,
  encryptJson,
  fromBase64Url,
  generateVaultKey,
  keyFromPassphrase,
  keyFromPrf,
  randomBytes,
  toBase64Url,
  unwrapVaultKey,
  wrapVaultKey,
} from "@/lib/vault/crypto"
import { createPasskey, evaluatePrf } from "@/lib/vault/passkey"
import { forgetKey, recallKey, rememberKey } from "@/lib/vault/remembered"

export type ChatGptConnection = ChatGptTokens & { client_id: string }

export type VaultContents = {
  format: 1
  openai_api_key?: string
  chatgpt?: ChatGptConnection
}

export type VaultState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "signed_out" }
  | { status: "none" }
  | { status: "locked"; record: VaultRecord }
  | { status: "unlocked"; record: VaultRecord; key: CryptoKey; contents: VaultContents }

export type KeyMethod = { kind: "passkey" } | { kind: "passphrase"; passphrase: string }

const EMPTY: VaultContents = { format: 1 }
export const MIN_PASSPHRASE = 12

export function passphraseProblem(passphrase: string, confirm: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters`
  if (passphrase !== confirm) return "The passphrases don't match"
  return null
}

/** The GitHub login, used as the passkey's account name. */
export async function currentLogin(): Promise<string> {
  const me = await api.me()
  if (!me.ok) throw new Error("Sign in with GitHub first")
  return me.data.login
}

let state: VaultState = { status: "loading" }
let loading = false
const listeners = new Set<() => void>()

function set(next: VaultState) {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function must<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

function unlocked() {
  if (state.status !== "unlocked") throw new Error("Unlock your vault first")
  return state
}

async function load() {
  if (loading) return
  loading = true
  try {
    set(await initialState())
  } finally {
    loading = false
  }
}

async function initialState(): Promise<VaultState> {
  const result = await api.vault()
  if (result.status === 401) {
    // The session ended (expired, or signed out elsewhere): stay unlocked only while signed in.
    await forgetKey()
    return { status: "signed_out" }
  }
  if (!result.ok) return { status: "error", message: result.error }
  const record = result.data.vault
  if (!record) {
    await forgetKey()
    return { status: "none" }
  }
  const key = await recallKey()
  if (key) {
    try {
      const contents = await decryptJson<VaultContents>(key, fromBase64Url(record.ciphertext))
      return { status: "unlocked", record, key, contents }
    } catch {
      // Remembered from a vault that has since been replaced.
      await forgetKey()
    }
  }
  return { status: "locked", record }
}

export function useVault(): VaultState {
  const current = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (state.status === "loading") void load()
  }, [])
  return current
}

export function getVault(): VaultState {
  return state
}

async function newKey(vaultKey: CryptoKey, login: string, method: KeyMethod, label: string): Promise<NewVaultKey> {
  if (method.kind === "passkey") {
    const salt = randomBytes(32)
    const { credentialId, output } = await createPasskey(login, salt)
    const wrapped = await wrapVaultKey(await keyFromPrf(output), vaultKey)
    return {
      kind: "passkey",
      label,
      credential_id: toBase64Url(credentialId),
      salt: toBase64Url(salt),
      wrapped_key: toBase64Url(wrapped),
    }
  }
  const salt = randomBytes(16)
  const wrapped = await wrapVaultKey(await keyFromPassphrase(method.passphrase, salt, PBKDF2_ITERATIONS), vaultKey)
  return {
    kind: "passphrase",
    label,
    salt: toBase64Url(salt),
    iterations: PBKDF2_ITERATIONS,
    wrapped_key: toBase64Url(wrapped),
  }
}

async function unlockKey(record: VaultRecord, method: KeyMethod): Promise<CryptoKey> {
  if (method.kind === "passkey") {
    const passkeys = record.keys.filter((k) => k.kind === "passkey")
    if (passkeys.length === 0) throw new Error("This vault has no passkeys. Use its passphrase.")
    const result = await evaluatePrf(
      passkeys.map((k) => ({ credentialId: fromBase64Url(k.credential_id!), salt: fromBase64Url(k.salt) })),
    )
    const id = toBase64Url(result.credentialId)
    const match = passkeys.find((k) => k.credential_id === id)
    if (!match) throw new Error("That passkey isn't one of this vault's keys")
    return unwrapVaultKey(await keyFromPrf(result.output), fromBase64Url(match.wrapped_key))
  }
  for (const k of record.keys.filter((k) => k.kind === "passphrase")) {
    const wrapping = await keyFromPassphrase(method.passphrase, fromBase64Url(k.salt), k.iterations!)
    try {
      return await unwrapVaultKey(wrapping, fromBase64Url(k.wrapped_key))
    } catch {
      // Wrong passphrase for this key; try the next.
    }
  }
  throw new Error("Wrong passphrase")
}

/** Re-reads the vault from the server, keeping it unlocked if the key still fits. */
async function reload(): Promise<VaultContents> {
  const current = unlocked()
  const record = must(await api.vault()).vault
  if (!record) {
    set({ status: "none" })
    throw new Error("The vault was deleted")
  }
  try {
    const contents = await decryptJson<VaultContents>(current.key, fromBase64Url(record.ciphertext))
    set({ status: "unlocked", record, key: current.key, contents })
    return contents
  } catch {
    // Reset and recreated elsewhere with a different key.
    await forgetKey()
    set({ status: "locked", record })
    throw new Error("The vault was replaced. Unlock it again.")
  }
}

export const vault = {
  retry() {
    set({ status: "loading" })
    void load()
  },

  async create(login: string, method: KeyMethod, label: string) {
    const key = await generateVaultKey()
    const ciphertext = toBase64Url(await encryptJson(key, EMPTY))
    const { vault: record } = must(await api.createVault({ ciphertext, key: await newKey(key, login, method, label) }))
    await rememberKey(key)
    set({ status: "unlocked", record, key, contents: EMPTY })
  },

  async unlock(method: KeyMethod) {
    if (state.status !== "locked") return
    const { record } = state
    const key = await unlockKey(record, method)
    const contents = await decryptJson<VaultContents>(key, fromBase64Url(record.ciphertext))
    await rememberKey(key)
    set({ status: "unlocked", record, key, contents })
  },

  /** Locks the vault and forgets its key on this computer. */
  lock() {
    void forgetKey()
    if (state.status === "unlocked") set({ status: "locked", record: state.record })
  },

  /** Forgets the vault key on this computer, then ends the session. */
  async signOut() {
    await forgetKey()
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
    window.location.assign("/")
  },

  reload,

  /**
   * Applies `mutate` and writes the vault back. Writes are compare-and-swap, so
   * on a conflict this re-reads the latest vault and applies `mutate` again.
   */
  async update(mutate: (contents: VaultContents) => VaultContents): Promise<VaultContents> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = unlocked()
      const contents = mutate(current.contents)
      const ciphertext = toBase64Url(await encryptJson(current.key, contents))
      const result = await api.updateVault({ version: current.record.version, ciphertext })
      if (result.ok) {
        set({ ...current, record: { ...current.record, version: result.data.version, ciphertext }, contents })
        return contents
      }
      if (result.status !== 409) throw new Error(result.error)
      await reload()
    }
    throw new Error("The vault kept changing while saving. Try again.")
  },

  async addKey(login: string, method: KeyMethod, label: string) {
    const current = unlocked()
    const key = must(await api.addVaultKey(await newKey(current.key, login, method, label)))
    const latest = unlocked()
    set({ ...latest, record: { ...latest.record, keys: [...latest.record.keys, key] } })
  },

  async removeKey(id: number) {
    must(await api.removeVaultKey(id))
    const latest = unlocked()
    set({ ...latest, record: { ...latest.record, keys: latest.record.keys.filter((k) => k.id !== id) } })
  },

  /** Deletes the vault and everything in it. */
  async reset() {
    must(await api.deleteVault())
    await forgetKey()
    set({ status: "none" })
  },
}
