import { useEffect, useRef, useState } from "react"
import { buttonClass, inputClass, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { api } from "@/lib/api"
import type { DiscussionState } from "@/lib/discussion"
import { cn } from "@/lib/utils"
import type { Pull, ReviewEvent } from "@/lib/types"

type ReviewPanelProps = {
  owner: string
  repo: string
  pull: Pull
  state: DiscussionState
}

/** Decisions already given, by the review state GitHub records for them. */
const DECIDED: Partial<Record<string, { event: ReviewEvent; button: string; done: string }>> = {
  APPROVED: { event: "approve", button: "✓ Approved", done: "You approved this commit." },
  CHANGES_REQUESTED: { event: "request_changes", button: "Changes requested", done: "You requested changes on this commit." },
}

const EVENTS: { value: ReviewEvent; label: string; description: string }[] = [
  { value: "comment", label: "Comment", description: "General feedback without approving." },
  { value: "approve", label: "Approve", description: "These changes can be merged." },
  { value: "request_changes", label: "Request changes", description: "This needs changes before it's merged." },
]

/**
 * Finishes your review on GitHub: comment, approve or request changes, with
 * any pending line comments. Pinned to the head commit on screen, so it's
 * refused if new commits were pushed since.
 */
export function ReviewPanel({ owner, repo, pull, state }: ReviewPanelProps) {
  const { discussion, write } = state
  const [open, setOpen] = useState(false)
  const [chosenEvent, setEvent] = useState<ReviewEvent>("comment")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Close on a click outside or Escape; the draft stays for next time.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  if (!discussion) return null
  const pending = discussion.pending_review
  // GitHub doesn't let authors approve or request changes on their own pull request.
  const ownPull = discussion.viewer_did_author
  // Your approval or change request on the commit on screen: giving it again would only duplicate it.
  const mine = discussion.viewer_review
  const decided = mine && mine.commit_sha === pull.head.sha ? DECIDED[mine.state] : undefined
  // It may have been given (here or on GitHub) after you picked it.
  const event = chosenEvent === decided?.event ? "comment" : chosenEvent
  const needsBody = event !== "approve" && !pending?.comments

  async function submit() {
    setBusy(true)
    const failed = await write(() => api.submitReview(owner, repo, pull.number, { head_sha: pull.head.sha, event, body }))
    setBusy(false)
    setError(failed)
    if (failed == null) {
      setBody("")
      setEvent("comment")
      setOpen(false)
    }
  }

  async function discard() {
    if (!window.confirm(`Discard your pending review and its ${pending?.comments ?? 0} comments?`)) return
    setBusy(true)
    setError(await write(() => api.discardReview(owner, repo, pull.number)))
    setBusy(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          pending ? buttonClass : secondaryButtonClass,
          !pending && decided?.event === "approve" && "text-green-700 dark:text-green-400",
          !pending && decided?.event === "request_changes" && "text-red-700 dark:text-red-400",
        )}
      >
        {pending ? `Review · ${pending.comments} pending` : (decided?.button ?? "Review")}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-2 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-md border border-neutral-200 bg-white p-4 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder={needsBody ? "Leave a comment" : "Leave a comment (optional)"}
            className={cn(inputClass, "w-full")}
          />
          <div className="flex flex-col gap-2">
            {EVENTS.map((option) => {
              const alreadyGiven = option.value === decided?.event
              const disabled = (ownPull && option.value !== "comment") || alreadyGiven
              return (
                <label key={option.value} className={cn("flex items-start gap-2", disabled && "opacity-50")}>
                  <input
                    type="radio"
                    name="review-event"
                    className="mt-1"
                    checked={event === option.value}
                    disabled={disabled}
                    onChange={() => setEvent(option.value)}
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    <span className="block text-xs text-neutral-500">
                      {alreadyGiven
                        ? decided?.done
                        : disabled
                          ? "Not on your own pull request."
                          : option.description}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" disabled={busy || (needsBody && !body.trim())} onClick={submit} className={buttonClass}>
              Submit review
            </button>
            {pending && (
              <button type="button" disabled={busy} onClick={discard} className={cn(linkButtonClass, "text-xs")}>
                Discard pending review
              </button>
            )}
          </div>
          {pending && (
            <p className="text-xs text-neutral-500">
              Includes your {pending.comments} pending comment{pending.comments === 1 ? "" : "s"}, which only you can see until
              you submit.
            </p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
