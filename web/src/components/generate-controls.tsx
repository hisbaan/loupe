import { useState } from "react"
import { Link } from "@/components/link"
import { buttonClass, errorMessage, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { VaultGate } from "@/components/vault-gate"
import { PROVIDER_LABELS, availableProviders, credentialFor, useInferencePreferences, type Provider } from "@/lib/inference"
import { EFFORTS, updateInferenceSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { JobProgress, JobRequest } from "@/lib/types"
import { useVault, type VaultContents } from "@/lib/vault/store"

/** One button that starts a generation job (a review, an update, a self-review). */
export type GenerateAction = {
  label: string
  title?: string
  secondary?: boolean
  run: (job: JobRequest, onProgress: (progress: JobProgress<unknown>) => void) => Promise<void>
}

type GenerateControlsProps = {
  actions: GenerateAction[]
}

/** Buttons for generation jobs, using the model chosen in settings, with an effort switch and progress. */
export function GenerateControls(props: GenerateControlsProps) {
  const state = useVault()
  if (state.status !== "unlocked") return <VaultGate />
  return <Controls {...props} contents={state.contents} />
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; message: string }
  | { kind: "error"; message: string }
/** What the job has done so far: fetching, each file read or search, generating. */
type Activity = string[]

function Controls({ actions, contents }: GenerateControlsProps & { contents: VaultContents }) {
  const { provider, model, effort } = useInferencePreferences(availableProviders(contents))
  const [run, setRun] = useState<RunState>({ kind: "idle" })
  const [activity, setActivity] = useState<Activity>([])

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
    setActivity([])
    let credential
    try {
      credential = await credentialFor(provider)
    } catch (err) {
      return setRun({ kind: "error", message: errorMessage(err) })
    }
    await action.run({ credential, model, effort }, (progress) => {
      switch (progress.type) {
        case "status":
          setRun({ kind: "running", message: progress.message })
          // "Generating" repeats on every turn; keep one per run of them.
          setActivity((a) => (a[a.length - 1] === progress.message ? a : [...a, progress.message]))
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
      <div role="radiogroup" aria-label="Effort" className="flex rounded-md border border-neutral-300 p-0.5 dark:border-neutral-700">
        {EFFORTS.map((e) => (
          <button
            key={e.value}
            type="button"
            role="radio"
            aria-checked={effort === e.value}
            title={e.description}
            disabled={run.kind === "running"}
            onClick={() => updateInferenceSettings({ effort: e.value })}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs",
              effort === e.value
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900",
            )}
          >
            {e.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-neutral-500">{EFFORTS.find((e) => e.value === effort)?.description}</p>
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
      {run.kind !== "idle" && activity.length > 0 && (
        <ol className="flex max-h-40 flex-col gap-0.5 overflow-y-auto font-mono text-xs text-neutral-500">
          {activity.map((step, i) => (
            <li key={i} className="truncate" title={step}>
              {step}
            </li>
          ))}
        </ol>
      )}
      {run.kind === "running" && <p className="text-xs text-neutral-500">{run.message}…</p>}
      {run.kind === "error" && <p className="text-xs text-red-600">{run.message}</p>}
    </div>
  )
}
