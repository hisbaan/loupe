// Preferences that follow you between computers: saved to your account on the
// server, with a copy in localStorage so the first paint uses them. Nothing
// secret goes in here; credentials live only in the vault.

import { useSyncExternalStore } from "react"
import { api } from "@/lib/api"
import { DEFAULT_DIFF_SETTINGS, parseDiffSettings, type DiffSettings } from "@/lib/diff-settings"
import type { Provider } from "@/lib/inference"

export type InferenceSettings = {
  /** Preferred when more than one is connected. */
  provider: Provider | null
  /** The model to use with each provider. */
  models: Partial<Record<Provider, string>>
}

export type Settings = {
  diff: DiffSettings
  inference: InferenceSettings
}

const PROVIDERS: Provider[] = ["chatgpt", "api_key"]
const CACHE_KEY = "loupe.settings"
const SAVE_DELAY_MS = 500

const isObject = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object"

function parseInference(value: unknown): InferenceSettings {
  const raw = isObject(value) ? value : {}
  const models: InferenceSettings["models"] = {}
  if (isObject(raw.models)) {
    for (const provider of PROVIDERS) {
      const model = raw.models[provider]
      if (typeof model === "string" && model.length <= 100) models[provider] = model
    }
  }
  return { provider: PROVIDERS.includes(raw.provider as Provider) ? (raw.provider as Provider) : null, models }
}

/** Fills in defaults for anything missing or unrecognised. */
function parseSettings(value: unknown): Settings {
  const raw = isObject(value) ? value : {}
  return { diff: parseDiffSettings(raw.diff), inference: parseInference(raw.inference) }
}

function readJson(text: string | null): unknown {
  try {
    return text == null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

/** Before settings were saved to the account, each lived in its own localStorage key. */
const LEGACY_KEYS = ["loupe.diff-settings", "loupe.provider", "loupe.model.chatgpt", "loupe.model.api_key"]

function initial(): Settings {
  const cached = readJson(localStorage.getItem(CACHE_KEY))
  if (cached != null) return parseSettings(cached)
  const legacy = parseSettings({
    diff: readJson(localStorage.getItem("loupe.diff-settings")),
    inference: {
      provider: localStorage.getItem("loupe.provider"),
      models: { chatgpt: localStorage.getItem("loupe.model.chatgpt"), api_key: localStorage.getItem("loupe.model.api_key") },
    },
  })
  localStorage.setItem(CACHE_KEY, JSON.stringify(legacy))
  for (const key of LEGACY_KEYS) localStorage.removeItem(key)
  return legacy
}

let settings = initial()
let saveTimer: number | null = null
/** Whether the server's copy has been read since the page loaded. */
let loaded = false
const listeners = new Set<() => void>()

function set(next: Settings) {
  settings = next
  localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

function scheduleSave() {
  if (saveTimer != null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    saveTimer = null
    await api.saveSettings(settings)
  }, SAVE_DELAY_MS)
}

/** Reads your settings from the server, unless a change of yours is waiting to be saved. */
async function pull() {
  const result = await api.settings()
  if (!result.ok || saveTimer != null) return
  if (Object.keys(result.data).length === 0) {
    // Nothing saved to the account yet: start it from this browser's settings.
    if (!loaded) scheduleSave()
  } else {
    set(parseSettings(result.data))
  }
  loaded = true
}

void pull()
// Pick up changes made on another computer when you come back to the tab.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void pull()
})
// And changes made in another tab of this browser.
window.addEventListener("storage", (event) => {
  if (event.key !== CACHE_KEY) return
  settings = parseSettings(readJson(event.newValue))
  for (const listener of listeners) listener()
})

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => settings)
}

export function getSettings(): Settings {
  return settings
}

export function updateSettings(change: (settings: Settings) => Settings) {
  set(change(settings))
  scheduleSave()
}

export const useDiffSettings = () => useSettings().diff

export function updateDiffSettings(change: Partial<DiffSettings>) {
  updateSettings((s) => ({ ...s, diff: { ...s.diff, ...change } }))
}

export function resetDiffSettings() {
  updateSettings((s) => ({ ...s, diff: DEFAULT_DIFF_SETTINGS }))
}

export function updateInferenceSettings(change: Partial<InferenceSettings>) {
  updateSettings((s) => ({ ...s, inference: { ...s.inference, ...change } }))
}
