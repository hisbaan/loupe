// Picks the inference credential for a job. Credentials come from the unlocked
// vault; only a short-lived token is ever sent to the server, with each request.

import { api } from "@/lib/api"
import { useSettings } from "@/lib/settings"
import type { Credential } from "@/lib/types"
import { getVault, vault, type ChatGptConnection, type VaultContents } from "@/lib/vault/store"

export type Provider = "chatgpt" | "api_key"

export const PROVIDER_LABELS: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  api_key: "OpenAI API key",
}

/** Refresh when less than this many seconds remain. */
const REFRESH_MARGIN = 5 * 60

export function availableProviders(contents: VaultContents): Provider[] {
  const providers: Provider[] = []
  if (contents.chatgpt) providers.push("chatgpt")
  if (contents.openai_api_key) providers.push("api_key")
  return providers
}

/** The provider to use (your preferred one if it's connected), its model and the effort. */
export function useInferencePreferences(available: Provider[]) {
  const { inference } = useSettings()
  const provider = inference.provider && available.includes(inference.provider) ? inference.provider : (available[0] ?? null)
  return { provider, model: provider ? (inference.models[provider] ?? "") : "", effort: inference.effort }
}

const now = () => Math.floor(Date.now() / 1000)
const isFresh = (c: ChatGptConnection) => c.expires_at - now() > REFRESH_MARGIN

/** Runs `fn` while holding a lock shared by every Loupe tab in this browser. */
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request(name, fn) : fn()
}

async function chatgptToken(contents: VaultContents): Promise<string> {
  if (contents.chatgpt && isFresh(contents.chatgpt)) return contents.chatgpt.access_token

  // Refresh tokens rotate and a used one stops working, so serialise refreshes
  // across tabs and re-read the vault first in case another tab or device
  // already refreshed.
  return withLock("loupe.chatgpt-refresh", async () => {
    const latest = (await vault.reload()).chatgpt
    if (!latest) throw new Error("ChatGPT isn't connected")
    if (isFresh(latest)) return latest.access_token
    if (!latest.refresh_token) throw new Error("ChatGPT sign-in expired. Run loupe-gateway login again.")

    const result = await api.refreshChatgpt({ client_id: latest.client_id, refresh_token: latest.refresh_token })
    if (!result.ok) {
      if (result.status === 410) {
        // Forget the dead connection, unless something replaced it meanwhile.
        await vault.update((c) =>
          c.chatgpt?.refresh_token === latest.refresh_token ? { ...c, chatgpt: undefined } : c,
        )
        throw new Error("ChatGPT sign-in expired. Run loupe-gateway login again.")
      }
      throw new Error(result.error)
    }
    const tokens = result.data
    await vault.update((c) => ({
      ...c,
      chatgpt: {
        ...tokens,
        client_id: latest.client_id,
        refresh_token: tokens.refresh_token ?? latest.refresh_token,
        id_token: tokens.id_token ?? latest.id_token,
      },
    }))
    return tokens.access_token
  })
}

/** The credential to send with one job. Refreshes ChatGPT tokens if needed. */
export async function credentialFor(provider: Provider): Promise<Credential> {
  const state = getVault()
  if (state.status !== "unlocked") throw new Error("Unlock your vault first")
  if (provider === "api_key") {
    if (!state.contents.openai_api_key) throw new Error("No OpenAI API key saved")
    return { kind: "api_key", token: state.contents.openai_api_key }
  }
  return { kind: "chatgpt", token: await chatgptToken(state.contents) }
}
