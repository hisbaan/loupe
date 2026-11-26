import type { ReactNode } from "react"
import { CommentBox, type CommentAction } from "@/components/discussion-comment"
import { LockIcon, agentNoteClass } from "@/components/agent-note"
import { noteClass } from "@/components/ui"
import type { DraftLineComment } from "@/components/review-thread"
import type { Destination } from "@/lib/notes"
import { cn } from "@/lib/utils"

/** Posting to GitHub, when the diff on screen is the pull request's current one. */
export type GitHubTarget =
  | {
      available: true
      /** Your review in progress: new comments join it. */
      pendingReview: boolean
      post: (body: string, review: boolean) => Promise<string | null>
    }
  | { available: false; reason: string }

type CommentComposerProps = {
  draft: DraftLineComment
  /** Text to start from, such as a finding being accepted. */
  initialBody?: string
  destination: Destination
  onDestination: (destination: Destination) => void
  github: GitHubTarget
  addNote: (body: string) => Promise<string | null>
  onCancel: () => void
}

/**
 * A new comment on a line range, either on GitHub or as a private note for
 * your coding agent. The destination you pick sticks for the next comment, and
 * each one looks different so you always know where you're writing.
 */
export function CommentComposer({
  draft,
  initialBody,
  destination,
  onDestination,
  github,
  addNote,
  onCancel,
}: CommentComposerProps) {
  const lines = draft.start_line === draft.end_line ? `line ${draft.end_line}` : `lines ${draft.start_line}-${draft.end_line}`

  // On GitHub, comments go into your pending review unless you choose to post one alone.
  const githubActions: CommentAction[] = !github.available
    ? []
    : github.pendingReview
      ? [{ label: "Add review comment", run: (body) => github.post(body, true) }]
      : [
          { label: "Start a review", run: (body) => github.post(body, true) },
          { label: "Post now", secondary: true, run: (body) => github.post(body, false) },
        ]
  const agentActions: CommentAction[] = [{ label: "Add note", run: addNote }]
  const actions = destination === "agent" ? agentActions : githubActions
  const other: Destination = destination === "agent" ? "github" : "agent"
  const otherAction = (other === "agent" ? agentActions : githubActions)[0]
  // ⌘⇧↵ sends to the other destination and makes it the one you're using.
  const shiftAction: CommentAction | undefined = otherAction && {
    label: otherAction.label,
    run: async (body) => {
      const failed = await otherAction.run(body)
      if (failed == null) onDestination(other)
      return failed
    },
  }

  return (
    <div className={cn(noteClass, destination === "agent" && agentNoteClass)}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>
          Comment on {lines}
          {draft.side === "old" && " (old version)"}
        </span>
        <div
          role="radiogroup"
          aria-label="Where this comment goes"
          className="ml-auto flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700"
        >
          <DestinationButton active={destination === "github"} onClick={() => onDestination("github")}>
            GitHub
          </DestinationButton>
          <DestinationButton active={destination === "agent"} onClick={() => onDestination("agent")}>
            <LockIcon />
            Agent
          </DestinationButton>
        </div>
      </div>
      {destination === "agent" ? (
        <p className="mb-2 text-xs text-violet-700 dark:text-violet-300">
          Only you can see this. It goes to your coding agent when you copy your notes.
        </p>
      ) : (
        !github.available && <p className="mb-2 text-xs text-amber-600">{github.reason}</p>
      )}
      <CommentBox
        autoFocus
        initialBody={initialBody}
        placeholder={destination === "agent" ? "What should your agent change here?" : "Leave a comment"}
        actions={actions}
        shiftAction={shiftAction}
        onCancel={onCancel}
      />
      <p className="mt-1 text-xs text-neutral-500">
        ⌘/Ctrl+Enter: {actions[0]?.label.toLowerCase() ?? "unavailable"}
        {shiftAction && ` · with Shift: ${other === "agent" ? "add as a note for your agent" : "add to your GitHub review"}`}
      </p>
    </div>
  )
}

function DestinationButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-2 py-0.5 font-medium",
        active
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
      )}
    >
      {children}
    </button>
  )
}
