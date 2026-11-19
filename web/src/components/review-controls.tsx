import { useState, type FormEvent } from "react"
import { api } from "@/lib/api"
import { useInferenceSettings } from "@/lib/inference-settings"
import type { ReviewRecord } from "@/lib/types"

type ReviewControlsProps = {
  owner: string
  repo: string
  number: number
  hasReview: boolean
  onReview: (record: ReviewRecord) => void
}

type RunState = { kind: "idle" } | { kind: "running"; message: string } | { kind: "error"; message: string }

export function ReviewControls({ owner, repo, number, hasReview, onReview }: ReviewControlsProps) {
  const { settings, update, credential } = useInferenceSettings()
  const [editing, setEditing] = useState(!credential || !settings.model)
  const [models, setModels] = useState<string[]>([])
  const [run, setRun] = useState<RunState>({ kind: "idle" })

  async function loadModels() {
    if (!credential) return
    const result = await api.models(credential)
    if (result.ok) setModels(result.data.models)
    else setRun({ kind: "error", message: result.error })
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (credential && settings.model) setEditing(false)
  }

  async function generate() {
    if (!credential || !settings.model) return
    setRun({ kind: "running", message: "Starting" })
    await api.generateReview(owner, repo, number, { credential, model: settings.model }, (progress) => {
      switch (progress.type) {
        case "status":
          setRun({ kind: "running", message: progress.message })
          break
        case "generating":
          setRun({ kind: "running", message: `Generating review (${Math.round(progress.chars / 1000)}k characters)` })
          break
        case "done":
          setRun({ kind: "idle" })
          onReview(progress.record)
          break
        case "error":
          setRun({ kind: "error", message: progress.message })
          break
      }
    })
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-neutral-500">OpenAI API key</span>
          <input
            type="password"
            autoComplete="off"
            value={settings.apiKey}
            onChange={(e) => update({ apiKey: e.target.value.trim() })}
            placeholder="sk-..."
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="flex items-center justify-between text-neutral-500">
            Model
            <button type="button" onClick={loadModels} disabled={!credential} className="text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400">
              Load models
            </button>
          </span>
          <input
            list="loupe-models"
            value={settings.model}
            onChange={(e) => update({ model: e.target.value.trim() })}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
          />
          <datalist id="loupe-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <p className="text-xs text-neutral-500">The key stays in this tab and is sent to Loupe only with each review request.</p>
        <button
          type="submit"
          disabled={!credential || !settings.model}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Save
        </button>
        {run.kind === "error" && <p className="text-xs text-red-600">{run.message}</p>}
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <button
        type="button"
        onClick={generate}
        disabled={run.kind === "running"}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {hasReview ? "Regenerate review" : "Generate guided review"}
      </button>
      <div className="flex justify-between text-xs text-neutral-500">
        <span className="truncate">{settings.model}</span>
        <button type="button" onClick={() => setEditing(true)} className="text-blue-600 hover:underline dark:text-blue-400">
          Settings
        </button>
      </div>
      {run.kind === "running" && <p className="text-xs text-neutral-500">{run.message}…</p>}
      {run.kind === "error" && <p className="text-xs text-red-600">{run.message}</p>}
    </div>
  )
}
