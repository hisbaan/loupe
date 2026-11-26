import { useState } from "react"
import { Link } from "@/components/link"
import { buttonClass, errorMessage, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { VaultGate } from "@/components/vault-gate"
import { PROVIDER_LABELS, availableProviders, credentialFor, useInferencePreferences, type Provider } from "@/lib/inference"
import { EFFORTS } from "@/lib/settings"
import type { JobProgress, JobRequest } from "@/lib/types"
import { useVault, type VaultContents } from "@/lib/vault/store"

/** One button that starts a generation job (a review, or an update of one). */
export type GenerateAction = {
  label: string
  title?: string
  secondary?: boolean
  run: (job: JobRequest, onProgress: (progress: JobProgress<unknown>) => void) => Promise<void>
}

type GenerateControlsProps = {
  actions: GenerateAction[]
}

/** Buttons for generation jobs, using the model and effort chosen in settings, with progress. */
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
            {` · ${EFFORTS.find((e) => e.value === effort)?.label ?? effort} effort · `}
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
