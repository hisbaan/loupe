import { useState } from "react"
import { CommentBox, CommentView, type CommentAction } from "@/components/discussion-comment"
import { linkButtonClass } from "@/components/ui"
import { api } from "@/lib/api"
import type { DiscussionState } from "@/lib/discussion"
import { cn } from "@/lib/utils"
import type { LineSide, ReviewThread } from "@/lib/types"

type ThreadViewProps = {
  thread: ReviewThread
  write: DiscussionState["write"]
  className?: string
}

/** A review thread: its comments, a reply box, and resolve. Resolved threads start folded. */
export function ThreadView({ thread, write, className }: ThreadViewProps) {
  const [open, setOpen] = useState(!thread.is_resolved)
  const [replying, setReplying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { comments } = thread
  const count = `${comments.total_count} comment${comments.total_count === 1 ? "" : "s"}`

  async function setResolved(resolved: boolean) {
    setBusy(true)
    const failed = await write(() => api.setResolved(thread.id, resolved))
    setBusy(false)
    setError(failed)
    if (failed == null && resolved) setOpen(false)
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {(thread.is_resolved || thread.is_outdated) && (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          {thread.is_resolved && <span className="font-medium">Resolved</span>}
          {thread.is_outdated && <span className="rounded border border-neutral-300 px-1 dark:border-neutral-700">Outdated</span>}
          {!open && <span>{count}</span>}
          <button type="button" onClick={() => setOpen((o) => !o)} className={linkButtonClass}>
            {open ? "Hide" : "Show"}
          </button>
        </div>
      )}
      {open && (
        <>
          {comments.nodes.map((comment) => (
            <CommentView key={comment.id} comment={comment} kind="review-comments" write={write} />
          ))}
          {comments.total_count > comments.nodes.length && (
            <a href={comments.nodes[0]?.url} target="_blank" rel="noreferrer" className={cn(linkButtonClass, "text-xs")}>
              {comments.total_count - comments.nodes.length} more on GitHub
            </a>
          )}
          {replying ? (
            <CommentBox
              autoFocus
              placeholder="Reply"
              onCancel={() => setReplying(false)}
              actions={[
                {
                  label: "Reply",
                  run: async (body) => {
                    const failed = await write(() => api.reply(thread.id, body))
                    if (failed == null) setReplying(false)
                    return failed
                  },
                },
              ]}
            />
          ) : (
            <div className="flex gap-3 text-xs">
              {thread.viewer_can_reply && (
                <button type="button" onClick={() => setReplying(true)} className={linkButtonClass}>
                  Reply
                </button>
              )}
              {thread.viewer_can_resolve && !thread.is_resolved && (
                <button type="button" disabled={busy} onClick={() => setResolved(true)} className={linkButtonClass}>
                  Resolve
                </button>
              )}
              {thread.viewer_can_unresolve && thread.is_resolved && (
                <button type="button" disabled={busy} onClick={() => setResolved(false)} className={linkButtonClass}>
                  Unresolve
                </button>
              )}
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </>
      )}
    </div>
  )
}

/** Where a new line comment goes, before it's posted. */
export type DraftLineComment = {
  path: string
  side: LineSide
  start_line: number
  end_line: number
}

type LineCommentFormProps = {
  draft: DraftLineComment
  /** Your review in progress: new comments join it instead of posting alone. */
  pendingReview: boolean
  post: (body: string, review: boolean) => Promise<string | null>
  onCancel: () => void
}

/** A new comment on a line range, posted now or added to your review, as on GitHub. */
export function LineCommentForm({ draft, pendingReview, post, onCancel }: LineCommentFormProps) {
  const lines = draft.start_line === draft.end_line ? `line ${draft.end_line}` : `lines ${draft.start_line}-${draft.end_line}`
  const actions: CommentAction[] = pendingReview
    ? [{ label: "Add review comment", run: (body) => post(body, true) }]
    : [
        { label: "Start a review", run: (body) => post(body, true) },
        { label: "Add single comment", secondary: true, run: (body) => post(body, false) },
      ]
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-neutral-500">
        Comment on {lines}
        {draft.side === "old" && " (old version)"}
      </span>
      <CommentBox autoFocus actions={actions} onCancel={onCancel} />
    </div>
  )
}
