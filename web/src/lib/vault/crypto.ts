// Vault cryptography, all in the browser with WebCrypto.
//
// A random 256-bit vault key (VK) encrypts the vault contents with AES-GCM. The
// VK is stored on the server only wrapped (AES-GCM) by keys the user derives:
// HKDF over a passkey's PRF output, or PBKDF2 over a passphrase. The server
// sees ciphertext, salts and credential ids, never a key.

const VAULT_AAD = new TextEncoder().encode("loupe vault v1")
const WRAP_AAD = new TextEncoder().encode("loupe vault key v1")
const HKDF_INFO = new TextEncoder().encode("loupe vault key wrap v1")
export const PBKDF2_ITERATIONS = 600_000

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of array) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function seal(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>) {
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext)
  const out = new Uint8Array(12 + ciphertext.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ciphertext), 12)
  return out
}

async function open(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: aad }, key, sealed.slice(12)),
  )
}

function importAesKey(raw: Uint8Array<ArrayBuffer>, extractable: boolean) {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"])
}

/** A new vault key. Extractable so further passkeys can wrap it. */
export function generateVaultKey() {
  return importAesKey(randomBytes(32), true)
}

export async function encryptJson(vaultKey: CryptoKey, value: unknown) {
  return seal(vaultKey, new TextEncoder().encode(JSON.stringify(value)), VAULT_AAD)
}

export async function decryptJson<T>(vaultKey: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await open(vaultKey, sealed, VAULT_AAD))) as T
}

export async function wrapVaultKey(wrappingKey: CryptoKey, vaultKey: CryptoKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", vaultKey))
  return seal(wrappingKey, raw, WRAP_AAD)
}

/** Throws if `wrappingKey` is the wrong key. */
export async function unwrapVaultKey(wrappingKey: CryptoKey, wrapped: Uint8Array<ArrayBuffer>) {
  return importAesKey(await open(wrappingKey, wrapped, WRAP_AAD), true)
}

export async function keyFromPrf(prfOutput: ArrayBuffer) {
  const ikm = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: HKDF_INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

export async function keyFromPassphrase(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ])
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}
