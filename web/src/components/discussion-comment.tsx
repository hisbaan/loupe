import { useState } from "react"
import { Markdown } from "@/components/markdown"
import { buttonClass, ghostButtonClass, inputClass, secondaryButtonClass } from "@/components/ui"
import { api, type CommentKind } from "@/lib/api"
import { isoTimeAgoSeconds, type DiscussionState } from "@/lib/discussion"
import { cn, timeAgo } from "@/lib/utils"
import type { Actor, DiscussionComment } from "@/lib/types"

export function Avatar({ actor, className }: { actor: Actor | null; className?: string }) {
  return actor?.avatar_url ? (
    <img src={actor.avatar_url} alt="" className={cn("size-6 shrink-0 rounded-full", className)} />
  ) : (
    <span className={cn("size-6 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800", className)} />
  )
}

type CommentViewProps = {
  comment: DiscussionComment
  kind: CommentKind
  write: DiscussionState["write"]
}

/**
 * A comment from GitHub. Bodies are other people's markdown, rendered only
 * through `Markdown`: as HTML on this origin it would put the vault key in reach.
 */
export function CommentView({ comment, kind, write }: CommentViewProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(request: Parameters<DiscussionState["write"]>[0]) {
    setBusy(true)
    const failed = await write(request)
    setBusy(false)
    setError(failed)
    return failed == null
  }

  async function save() {
    if (await run(() => api.editComment(kind, comment.id, draft.trim()))) setEditing(false)
  }

  async function remove() {
    if (window.confirm("Delete this comment on GitHub?")) await run(() => api.deleteComment(kind, comment.id))
  }

  return (
    <div className="flex gap-2">
      <Avatar actor={comment.author} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-6 flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span className="font-medium text-neutral-900 dark:text-neutral-100">{comment.author?.login ?? "ghost"}</span>
          <a href={comment.url} target="_blank" rel="noreferrer" className="hover:underline">
            {timeAgo(isoTimeAgoSeconds(comment.created_at))}
          </a>
          {comment.state === "PENDING" && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Pending
            </span>
          )}
          {!editing && (comment.viewer_can_update || comment.viewer_can_delete) && (
            <div className="ml-auto flex gap-1">
              {comment.viewer_can_update && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(comment.body)
                    setEditing(true)
                  }}
                  className={ghostButtonClass}
                >
                  Edit
                </button>
              )}
              {comment.viewer_can_delete && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={remove}
                  className={cn(ghostButtonClass, "hover:text-red-600 dark:hover:text-red-400")}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
        {editing ? (
          <div className="mt-1 flex flex-col gap-2">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className={cn(inputClass, "w-full")} />
            <div className="flex gap-2">
              <button type="button" disabled={busy || !draft.trim()} onClick={save} className={buttonClass}>
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)} className={secondaryButtonClass}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <Markdown baseUrl={comment.url} className="mt-0.5">
            {comment.body}
          </Markdown>
        )}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  )
}

export type CommentAction = {
  label: string
  secondary?: boolean
  /** Resolves to an error message, or null when done. */
  run: (body: string) => Promise<string | null>
}

type CommentBoxProps = {
  actions: CommentAction[]
  /** Run by ⌘/Ctrl+Shift+Enter; ⌘/Ctrl+Enter runs the first action. */
  shiftAction?: CommentAction
  placeholder?: string
  initialBody?: string
  onCancel?: () => void
  autoFocus?: boolean
}

/** A textarea with one button per way to post it. */
export function CommentBox({
  actions,
  shiftAction,
  placeholder = "Leave a comment",
  initialBody = "",
  onCancel,
  autoFocus = false,
}: CommentBoxProps) {
  const [body, setBody] = useState(initialBody)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(action: CommentAction) {
    setBusy(true)
    const failed = await action.run(body.trim())
    setBusy(false)
    setError(failed)
    if (failed == null) setBody("")
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return
          const action = e.shiftKey ? shiftAction : actions[0]
          if (!action || busy || !body.trim()) return
          e.preventDefault()
          submit(action)
        }}
        rows={initialBody ? 6 : 3}
        placeholder={placeholder}
        className={cn(inputClass, "w-full")}
      />
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={busy || !body.trim()}
            onClick={() => submit(action)}
            className={action.secondary ? secondaryButtonClass : buttonClass}
          >
            {action.label}
          </button>
        ))}
        {onCancel && (
          <button type="button" onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
