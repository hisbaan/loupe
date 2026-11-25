import { useState } from "react"
import { Link } from "@/components/link"
import { buttonClass, errorMessage, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { VaultGate } from "@/components/vault-gate"
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

/** Buttons for generation jobs, using the model chosen in settings. */
export function GenerateControls(props: GenerateControlsProps) {
  const state = useVault()
  if (state.status !== "unlocked") return <VaultGate />
  return <Controls {...props} contents={state.contents} />
}

type RunState = { kind: "idle" } | { kind: "running"; message: string } | { kind: "error"; message: string }

function Controls({ actions, contents }: GenerateControlsProps & { contents: VaultContents }) {
  const { provider, model } = useInferencePreferences(availableProviders(contents))
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
      <p className="text-neutral-500">
        {model ? (
          <>
            <span className="font-mono text-neutral-900 dark:text-neutral-100">{model}</span> via {PROVIDER_LABELS[provider]}
            {" · "}
          </>
        ) : (
          "No model chosen. "
        )}
        <Link href="/settings" className={linkButtonClass}>
          {model ? "Change" : "Choose one in settings"}
        </Link>
      </p>
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
