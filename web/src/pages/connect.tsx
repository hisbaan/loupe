import { useState } from "react"
import { Layout } from "@/components/layout"

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
    const json = atob(fragment.replace(/-/g, "+").replace(/_/g, "/"))
    const handoff = JSON.parse(json) as ChatGptHandoff
    return handoff.version === 1 ? handoff : null
  } catch {
    return null
  }
}

/**
 * Landing page for `loupe-gateway login`. The tokens arrive in the URL fragment,
 * which browsers never send to the server.
 */
export function ConnectPage() {
  // TODO(vault): encrypt into the passkey (WebAuthn PRF) vault and upload the
  // ciphertext. Until then the handoff only lives in this page's memory.
  const [handoff] = useState(readHandoff)

  return (
    <Layout>
      <div className="mx-auto mt-24 max-w-md text-center">
        {handoff ? (
          <>
            <h1 className="text-2xl font-semibold">ChatGPT connected</h1>
            <p className="mt-2 text-neutral-500">
              Received credentials expiring {new Date(handoff.expires_at * 1000).toLocaleTimeString()}.
            </p>
            <p className="mt-4 text-sm text-amber-600">
              The passkey vault isn't built yet, so these credentials are discarded when you leave this page.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">Nothing to connect</h1>
            <p className="mt-2 text-neutral-500">
              Run <code className="font-mono">loupe-gateway login --server {window.location.origin}</code> to connect ChatGPT.
            </p>
          </>
        )}
      </div>
    </Layout>
  )
}
