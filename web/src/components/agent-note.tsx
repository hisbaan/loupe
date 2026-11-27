import { useState } from "react"
import { Markdown } from "@/components/markdown"
import { buttonClass, ghostButtonClass, inputClass, noteClass, secondaryButtonClass } from "@/components/ui"
import { cn } from "@/lib/utils"
import type { AgentNote } from "@/lib/types"

/**
 * Marks notes for your agent apart from GitHub comments, which other people see. The violet is
 * in the borders; the background is only a faint tint, kept opaque so the diff's line highlight
 * doesn't show through it.
 */
export const agentNoteClass =
  "border-y-violet-300 border-l-4 border-l-violet-400 border-dashed bg-[color-mix(in_oklab,var(--color-violet-500)_4%,var(--color-white))] dark:border-y-violet-800 dark:border-l-violet-700 dark:bg-[color-mix(in_oklab,var(--color-violet-500)_7%,var(--color-neutral-950))]"

export function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3", className)} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  )
}

/** The "for your agent · only you" label. */
export function AgentBadge() {
  return (
    <span
      className="flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300"
      title="Only you can see this note"
    >
      <LockIcon />
      for your agent
    </span>
  )
}

type AgentNoteViewProps = {
  note: AgentNote
  /** The pull request on GitHub; links in the note are shown as text. */
  baseUrl: string
  /** Each resolves to an error message, or null when done. */
  update: (change: { body?: string; resolved?: boolean }) => Promise<string | null>
  remove: () => Promise<string | null>
  /** Moves the note into your pending GitHub review; absent when GitHub comments are paused. */
  moveToGitHub?: () => Promise<string | null>
}

/** One of your notes for your agent, in the diff under the lines it's about. */
export function AgentNoteView({ note, baseUrl, update, remove, moveToGitHub }: AgentNoteViewProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [open, setOpen] = useState(!note.resolved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<string | null>) {
    setBusy(true)
    const failed = await action()
    setBusy(false)
    setError(failed)
    return failed == null
  }

  return (
    <div className={cn(noteClass, agentNoteClass, note.resolved && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <AgentBadge />
        {note.resolved && <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium dark:bg-neutral-800">Resolved</span>}
        {note.handed_off_sha && !note.resolved && (
          <span title="Included the last time you copied your notes for your agent">
            handed off at {note.handed_off_sha.slice(0, 7)}
          </span>
        )}
        {!editing && (
          <div className="ml-auto flex gap-1">
            {note.resolved ? (
              <>
                <button type="button" onClick={() => setOpen((o) => !o)} className={ghostButtonClass}>
                  {open ? "Hide" : "Show"}
                </button>
                <button type="button" disabled={busy} onClick={async () => {
                    if (await run(() => update({ resolved: false }))) setOpen(true)
                  }} className={ghostButtonClass}>
                  Reopen
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(note.body)
                    setEditing(true)
                  }}
                  className={ghostButtonClass}
                >
                  Edit
                </button>
                {moveToGitHub && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(moveToGitHub)}
                    title="Add it to your pending GitHub review instead, where others will see it once you submit"
                    className={ghostButtonClass}
                  >
                    Move to GitHub
                  </button>
                )}
                <button type="button" disabled={busy} onClick={async () => {
                    if (await run(() => update({ resolved: true }))) setOpen(false)
                  }} className={ghostButtonClass}>
                  Resolve
                </button>
              </>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => run(remove)}
              className={cn(ghostButtonClass, "hover:text-red-600 dark:hover:text-red-400")}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className={cn(inputClass, "w-full bg-white dark:bg-neutral-950")}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={async () => {
                if (await run(() => update({ body: draft.trim() }))) setEditing(false)
              }}
              className={buttonClass}
            >
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        open && (
          <Markdown baseUrl={baseUrl} links={false} className="mt-1">
            {note.body}
          </Markdown>
        )
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
