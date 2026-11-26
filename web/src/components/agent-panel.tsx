import { useState } from "react"
import { LockIcon } from "@/components/agent-note"
import { errorMessage, ghostButtonClass, secondaryButtonClass } from "@/components/ui"
import { exportMarkdown, isPlaced, type AgentNotesState } from "@/lib/notes"
import type { AnalyzedFile, Pull, ReviewThread } from "@/lib/types"

type AgentPanelProps = {
  owner: string
  repo: string
  pull: Pull
  files: AnalyzedFile[]
  state: AgentNotesState
  /** The pull request's review threads on GitHub, once loaded. */
  threads: ReviewThread[]
}

/**
 * Hands your open notes (and, if you like, unresolved GitHub threads) to your
 * coding agent as markdown, and after it pushes, lists the notes whose lines
 * changed so you can check and resolve them.
 */
export function AgentPanel({ owner, repo, pull, files, state, threads }: AgentPanelProps) {
  const [includeThreads, setIncludeThreads] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const hunkIds = new Set(files.flatMap((f) => f.analysis.hunks.map((h) => h.id)))
  const open = state.notes.filter((n) => !n.resolved)
  const moved = open.filter((n) => !isPlaced(n, hunkIds, pull.head.sha))
  const resolved = state.notes.length - open.length
  const unresolved = threads.filter((t) => !t.is_resolved)
  const exported = { notes: open, threads: includeThreads ? unresolved : [] }
  const total = exported.notes.length + exported.threads.length

  const markdown = () => exportMarkdown({ owner, repo, pull, files, ...exported })

  async function handOff(deliver: () => Promise<void> | void, done: string) {
    try {
      await deliver()
    } catch (err) {
      return setMessage(errorMessage(err))
    }
    const failed = open.length > 0 ? await state.handOff(pull.head.sha) : null
    setMessage(failed ? `${done}, but couldn't record the hand-off: ${failed}` : done)
  }

  function download() {
    const url = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `review-${repo}-${pull.number}-${pull.head.sha.slice(0, 7)}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <h2 className="flex items-center gap-1 text-xs font-medium tracking-wide text-violet-700 uppercase dark:text-violet-300">
        <LockIcon />
        For your agent
      </h2>
      <p className="text-neutral-500">
        {open.length === 0 && unresolved.length === 0
          ? "No notes yet. Pick Agent when you comment on a line to write one; only you can see them."
          : `${plural(open.length, "open note")}${resolved > 0 ? ` (${resolved} resolved)` : ""}.`}
      </p>
      {unresolved.length > 0 && (
        <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" checked={includeThreads} onChange={(e) => setIncludeThreads(e.target.checked)} />
          Include {plural(unresolved.length, "unresolved GitHub thread")}
        </label>
      )}
      {total > 0 && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handOff(() => navigator.clipboard.writeText(markdown()), "Copied")}
            className={secondaryButtonClass}
          >
            Copy for agent
          </button>
          <button type="button" onClick={() => handOff(download, "Downloaded")} className={secondaryButtonClass}>
            Download
          </button>
        </div>
      )}
      {message && <p className="text-xs text-neutral-500">{message}</p>}
      {state.error && <p className="text-xs text-red-600">Couldn't load your notes: {state.error}</p>}
      {moved.length > 0 && (
        <div className="mt-1 flex flex-col gap-1">
          <h3 className="text-xs font-medium text-amber-700 dark:text-amber-400">Lines changed since</h3>
          <p className="text-xs text-neutral-500">
            These notes' lines changed in a later commit, so they're no longer in the diff. Resolve the ones that were
            addressed; the rest stay in the next hand-off.
          </p>
          {moved.map((note) => (
            <div key={note.id} className="flex flex-col gap-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
              <span className="truncate font-mono text-xs text-neutral-500" title={note.path}>
                {note.path}:{note.start_line}
              </span>
              <span className="line-clamp-3 text-xs whitespace-pre-wrap">{note.body}</span>
              <span className="text-xs text-neutral-500">
                {note.handed_off_sha
                  ? `Handed off at ${note.handed_off_sha.slice(0, 7)}`
                  : `Written on ${note.head_sha.slice(0, 7)}`}
              </span>
              <div className="flex gap-1">
                <button type="button" onClick={() => state.update(note.id, { resolved: true })} className={ghostButtonClass}>
                  Resolve
                </button>
                <button
                  type="button"
                  onClick={() => state.remove(note.id)}
                  className={`${ghostButtonClass} hover:text-red-600 dark:hover:text-red-400`}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
