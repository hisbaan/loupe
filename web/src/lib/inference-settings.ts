import { useState } from "react"
import type { Credential } from "@/lib/types"

// TODO(vault): replace with the passkey vault. Until then the key lives in
// sessionStorage, so it's gone when the tab closes, and is only ever sent to
// the Loupe server with a review request.
const KEY = "loupe.openai_api_key"
const MODEL = "loupe.model"

export type InferenceSettings = {
  apiKey: string
  model: string
}

function read(): InferenceSettings {
  return { apiKey: sessionStorage.getItem(KEY) ?? "", model: localStorage.getItem(MODEL) ?? "" }
}

export function useInferenceSettings() {
  const [settings, setSettings] = useState(read)

  function update(next: Partial<InferenceSettings>) {
    const merged = { ...settings, ...next }
    if (merged.apiKey) sessionStorage.setItem(KEY, merged.apiKey)
    else sessionStorage.removeItem(KEY)
    localStorage.setItem(MODEL, merged.model)
    setSettings(merged)
  }

  const credential: Credential | null = settings.apiKey ? { kind: "api_key", token: settings.apiKey } : null
  return { settings, update, credential }
}
