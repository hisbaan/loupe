import { Avatar, CommentBox, CommentView } from "@/components/discussion-comment"
import { ThreadView } from "@/components/review-thread"
import { linkButtonClass } from "@/components/ui"
import { api } from "@/lib/api"
import { isoTimeAgoSeconds, threadLocation, type DiscussionState } from "@/lib/discussion"
import { cn, timeAgo } from "@/lib/utils"
import type { DiscussionComment, Pull, SubmittedReview } from "@/lib/types"

type ConversationProps = {
  owner: string
  repo: string
  pull: Pull
  state: DiscussionState
  /** Shows a thread's file in the diff. */
  onShowFile: (path: string) => void
}

type Item = { at: string; comment: DiscussionComment } | { at: string; review: SubmittedReview }

const REVIEW_VERBS: Record<SubmittedReview["state"], string> = {
  APPROVED: "approved these changes",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "reviewed (dismissed)",
}

const REVIEW_COLORS: Record<SubmittedReview["state"], string> = {
  APPROVED: "text-green-700 dark:text-green-400",
  CHANGES_REQUESTED: "text-red-700 dark:text-red-400",
  COMMENTED: "",
  DISMISSED: "text-neutral-500",
}

/** The pull request's description, conversation, reviews and every review thread. */
export function Conversation({ owner, repo, pull, state, onShowFile }: ConversationProps) {
  const { discussion, error, write } = state
  if (!discussion) return <p className="text-sm text-neutral-500">{error ?? "Loading the conversation…"}</p>

  const items: Item[] = [
    ...discussion.comments.map((comment) => ({ at: comment.created_at, comment })),
    ...discussion.reviews.map((review) => ({ at: review.submitted_at ?? "", review })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  // Unresolved first, then by file.
  const threads = [...discussion.threads].sort(
    (a, b) => Number(a.is_resolved) - Number(b.is_resolved) || a.path.localeCompare(b.path),
  )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 text-sm">
      {discussion.truncated && (
        <p className="text-amber-600">
          This pull request has more discussion than Loupe loads.{" "}
          <a href={pull.html_url} target="_blank" rel="noreferrer" className={linkButtonClass}>
            See all of it on GitHub
          </a>
          .
        </p>
      )}

      <section className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
          <Avatar actor={pull.user} />
          <span className="font-medium text-neutral-900 dark:text-neutral-100">{pull.user.login}</span>
          <span>opened this pull request</span>
        </div>
        {pull.body?.trim() ? (
          <p className="break-words whitespace-pre-wrap">{pull.body}</p>
        ) : (
          <p className="text-neutral-500">No description.</p>
        )}
      </section>

      {items.map((item) =>
        "comment" in item ? (
          <section key={item.comment.id} className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            <CommentView comment={item.comment} kind="issue-comments" write={write} />
          </section>
        ) : (
          <ReviewItem key={item.review.id} review={item.review} />
        ),
      )}

      {threads.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Review threads</h2>
          {threads.map((thread) => (
            <div key={thread.id} className="rounded-md border border-neutral-200 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => onShowFile(thread.path)}
                className="block w-full truncate border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-left font-mono text-xs hover:underline dark:border-neutral-800 dark:bg-neutral-900"
              >
                {threadLocation(thread)}
              </button>
              <ThreadView thread={thread} write={write} className="p-4" />
            </div>
          ))}
        </section>
      )}

      <section>
        {discussion.locked && !discussion.viewer_did_author ? (
          <p className="text-neutral-500">This conversation is locked.</p>
        ) : (
          <CommentBox
            actions={[{ label: "Comment", run: (body) => write(() => api.addComment(owner, repo, pull.number, body)) }]}
          />
        )}
      </section>
    </div>
  )
}

function ReviewItem({ review }: { review: SubmittedReview }) {
  const comments = review.comments.total_count
  return (
    <section className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <Avatar actor={review.author} />
        <span className="font-medium text-neutral-900 dark:text-neutral-100">{review.author?.login ?? "ghost"}</span>
        <span className={cn("font-medium", REVIEW_COLORS[review.state])}>{REVIEW_VERBS[review.state]}</span>
        {review.submitted_at && (
          <a href={review.url} target="_blank" rel="noreferrer" className="hover:underline">
            {timeAgo(isoTimeAgoSeconds(review.submitted_at))}
          </a>
        )}
        {comments > 0 && (
          <span>
            · {comments} line comment{comments === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {review.body.trim() && <p className="mt-2 break-words whitespace-pre-wrap">{review.body}</p>}
    </section>
  )
}
