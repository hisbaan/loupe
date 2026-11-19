import { useEffect, useRef, useState } from "react"
import { Layout } from "@/components/layout"
import { errorMessage, linkButtonClass } from "@/components/ui"
import { VaultGate } from "@/components/vault-gate"
import { Link } from "@/components/link"
import { fromBase64Url } from "@/lib/vault/crypto"
import { useVault, vault } from "@/lib/vault/store"

/** Shape of `loupe_protocol::handoff::ChatGptHandoff`. */
type ChatGptHandoff = {
  version: number
  client_id: string
  ext_agent_host_id: string
  access_token: string
  refresh_token: string | null
  id_token: string | null
  expires_at: number
  scope: string
}

function readHandoff(): ChatGptHandoff | null {
  const fragment = window.location.hash.slice(1)
  if (!fragment) return null
  // Drop the tokens from the address bar and history straight away.
  window.history.replaceState(null, "", window.location.pathname)
  try {
    const handoff = JSON.parse(new TextDecoder().decode(fromBase64Url(fragment))) as ChatGptHandoff
    return handoff.version === 1 ? handoff : null
  } catch {
    return null
  }
}

type SaveState = { kind: "pending" } | { kind: "saved" } | { kind: "error"; message: string }

/**
 * Landing page for `loupe-gateway login`. The tokens arrive in the URL fragment,
 * which browsers never send to the server, and go straight into the vault.
 * Until then they exist only in this page's memory.
 */
export function ConnectPage() {
  const [handoff] = useState(readHandoff)
  const state = useVault()
  const [save, setSave] = useState<SaveState>({ kind: "pending" })
  const unlocked = state.status === "unlocked"
  const saving = useRef(false)

  useEffect(() => {
    if (!handoff || !unlocked || save.kind !== "pending" || saving.current) return
    saving.current = true
    const { client_id, access_token, refresh_token, id_token, expires_at, scope } = handoff
    vault
      .update((c) => ({ ...c, chatgpt: { client_id, access_token, refresh_token, id_token, expires_at, scope } }))
      .then(
        () => setSave({ kind: "saved" }),
        (err) => setSave({ kind: "error", message: errorMessage(err) }),
      )
      .finally(() => (saving.current = false))
  }, [handoff, unlocked, save.kind])

  if (!handoff) {
    return (
      <Layout>
        <div className="mx-auto mt-24 max-w-md text-center">
          <h1 className="text-2xl font-semibold">Nothing to connect</h1>
          <p className="mt-2 text-neutral-500">
            Run <code className="font-mono">loupe-gateway login --server {window.location.origin}</code> to connect
            ChatGPT.
          </p>
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="mx-auto mt-24 max-w-md">
        {save.kind === "saved" ? (
          <div className="text-center">
            <h1 className="text-2xl font-semibold">ChatGPT connected</h1>
            <p className="mt-2 text-neutral-500">Your ChatGPT sign-in is saved in your vault.</p>
            <Link href="/" className={`mt-4 inline-block ${linkButtonClass}`}>
              Review a pull request
            </Link>
          </div>
        ) : (
          <>
            <h1 className="mb-2 text-center text-2xl font-semibold">Save your ChatGPT sign-in</h1>
            <p className="mb-6 text-center text-sm text-neutral-500">
              Don't leave this page until it's saved. The sign-in isn't stored anywhere else.
            </p>
            {state.status === "signed_out" ? (
              <p className="text-center text-sm text-neutral-500">
                Sign in to Loupe with GitHub first, then run <code className="font-mono">loupe-gateway login</code>{" "}
                again.
              </p>
            ) : (
              <VaultGate />
            )}
            {save.kind === "pending" && unlocked && <p className="text-center text-sm text-neutral-500">Saving…</p>}
            {save.kind === "error" && (
              <p className="text-center text-sm text-red-600">
                {save.message}.{" "}
                <button type="button" onClick={() => setSave({ kind: "pending" })} className={linkButtonClass}>
                  Try again
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </Layout>
  )
}
