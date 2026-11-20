import { useState } from "react"
import { Link } from "@/components/link"
import { buttonClass, errorMessage, inputClass, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { VaultGate } from "@/components/vault-gate"
import { api } from "@/lib/api"
import { PROVIDER_LABELS, availableProviders, credentialFor, useInferencePreferences, type Provider } from "@/lib/inference"
import type { Credential, JobProgress } from "@/lib/types"
import { useVault, type VaultContents } from "@/lib/vault/store"

/** One button that starts a generation job (a review, an update, a self-review). */
export type GenerateAction = {
  label: string
  title?: string
  secondary?: boolean
  run: (credential: Credential, model: string, onProgress: (progress: JobProgress<unknown>) => void) => Promise<void>
}

type GenerateControlsProps = {
  actions: GenerateAction[]
}

/** Provider and model pickers plus buttons for generation jobs. */
export function GenerateControls(props: GenerateControlsProps) {
  const state = useVault()
  if (state.status !== "unlocked") return <VaultGate />
  return <Controls {...props} contents={state.contents} />
}

type RunState = { kind: "idle" } | { kind: "running"; message: string } | { kind: "error"; message: string }

function Controls({ actions, contents }: GenerateControlsProps & { contents: VaultContents }) {
  const providers = availableProviders(contents)
  const { provider, model, setProvider, setModel } = useInferencePreferences(providers)
  const [models, setModels] = useState<string[]>([])
  const [run, setRun] = useState<RunState>({ kind: "idle" })

  if (!provider) {
    return (
      <p className="text-sm text-neutral-500">
        No inference credentials yet.{" "}
        <Link href="/settings" className={linkButtonClass}>
          Connect ChatGPT or add an API key
        </Link>
        .
      </p>
    )
  }

  async function loadModels(provider: Provider) {
    try {
      const result = await api.models(await credentialFor(provider))
      if (result.ok) setModels(result.data.models)
      else setRun({ kind: "error", message: result.error })
    } catch (err) {
      setRun({ kind: "error", message: errorMessage(err) })
    }
  }

  async function start(action: GenerateAction, provider: Provider) {
    setRun({ kind: "running", message: "Starting" })
    let credential
    try {
      credential = await credentialFor(provider)
    } catch (err) {
      return setRun({ kind: "error", message: errorMessage(err) })
    }
    await action.run(credential, model, (progress) => {
      switch (progress.type) {
        case "status":
          setRun({ kind: "running", message: progress.message })
          break
        case "generating":
          setRun({ kind: "running", message: `Generating (${Math.round(progress.chars / 1000)}k characters)` })
          break
        case "done":
          setRun({ kind: "idle" })
          break
        case "error":
          setRun({ kind: "error", message: progress.message })
          break
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {providers.length > 1 && (
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as Provider)
            setModels([])
          }}
          className={inputClass}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      )}
      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-neutral-500">
          Model{providers.length === 1 && ` (${PROVIDER_LABELS[provider]})`}
          <button type="button" onClick={() => loadModels(provider)} className={linkButtonClass}>
            Load models
          </button>
        </span>
        <input list="loupe-models" value={model} onChange={(e) => setModel(e.target.value.trim())} className={inputClass} />
        <datalist id="loupe-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => start(action, provider)}
          disabled={run.kind === "running" || !model}
          title={action.title}
          className={action.secondary ? secondaryButtonClass : buttonClass}
        >
          {action.label}
        </button>
      ))}
      {run.kind === "running" && <p className="text-xs text-neutral-500">{run.message}…</p>}
      {run.kind === "error" && <p className="text-xs text-red-600">{run.message}</p>}
    </div>
  )
}
