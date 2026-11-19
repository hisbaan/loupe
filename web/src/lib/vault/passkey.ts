// Passkeys used only for their WebAuthn PRF output, which derives the key that
// wraps the vault key. Nothing is verified server-side: the server can't decrypt
// the vault either way, so the passkey's job is purely to produce the secret.

import { randomBytes, toBase64Url } from "@/lib/vault/crypto"

export class PrfUnsupportedError extends Error {
  constructor() {
    super("This browser or passkey provider doesn't support the PRF extension. Use a passphrase instead.")
  }
}

/** `false` when the browser says outright that PRF isn't available. */
export async function prfMaybeSupported(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined") return false
  if (!PublicKeyCredential.getClientCapabilities) return true
  const capabilities = await PublicKeyCredential.getClientCapabilities().catch(() => null)
  return capabilities?.["extension:prf"] !== false
}

type PrfResult = { credentialId: Uint8Array<ArrayBuffer>; output: ArrayBuffer }

function prfOutput(credential: PublicKeyCredential): ArrayBuffer | null {
  const first = credential.getClientExtensionResults().prf?.results?.first
  if (!first) return null
  return first instanceof ArrayBuffer ? first : (first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) as ArrayBuffer)
}

/** Registers a new passkey for Loupe and evaluates its PRF with `salt`. */
export async function createPasskey(login: string, salt: Uint8Array<ArrayBuffer>): Promise<PrfResult> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Loupe" },
      // A fresh user handle per passkey, so registering another one on the same
      // authenticator never replaces a passkey that already wraps the vault.
      user: { id: randomBytes(16), name: login, displayName: `${login} (Loupe vault)` },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } },
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error("Passkey creation was cancelled")
  const credentialId = new Uint8Array(credential.rawId)

  if (!credential.getClientExtensionResults().prf?.enabled) throw new PrfUnsupportedError()
  // Some authenticators only evaluate PRF during an assertion.
  const output = prfOutput(credential) ?? (await evaluatePrf([{ credentialId, salt }])).output
  return { credentialId, output }
}

/** Asks the user for one of `keys` and returns its PRF output. */
export async function evaluatePrf(
  keys: { credentialId: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer> }[],
): Promise<PrfResult> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credentialId })),
      userVerification: "required",
      extensions: {
        prf: { evalByCredential: Object.fromEntries(keys.map((k) => [toBase64Url(k.credentialId), { first: k.salt }])) },
      },
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error("Passkey request was cancelled")
  const output = prfOutput(credential)
  if (!output) throw new PrfUnsupportedError()
  return { credentialId: new Uint8Array(credential.rawId), output }
}
