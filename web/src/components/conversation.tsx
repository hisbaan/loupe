import { Avatar, CommentBox, CommentView } from "@/components/discussion-comment"
import { Markdown } from "@/components/markdown"
import { ThreadView } from "@/components/review-thread"
import { linkButtonClass } from "@/components/ui"
import { api } from "@/lib/api"
import { isoTimeAgoSeconds, threadLocation, type DiscussionState } from "@/lib/discussion"
import { cn, timeAgo } from "@/lib/utils"
import type { DiscussionComment, Pull, ReviewThread, SubmittedReview } from "@/lib/types"

type ConversationProps = {
  owner: string
  repo: string
  pull: Pull
  state: DiscussionState
  /** Shows a thread in the diff. */
  onShowThread: (thread: ReviewThread) => void
}

type Item = { at: string; comment: DiscussionComment } | { at: string; review: SubmittedReview }

/**
 * A timeline entry. Reviews without a body (GitHub makes one for every line
 * comment and reply) are quiet: a line, not a card, with a run of them by one
 * person folded together.
 */
type Entry = { comment: DiscussionComment } | { review: SubmittedReview } | { quiet: SubmittedReview[] }

const THREADS_ID = "review-threads"

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
export function Conversation({ owner, repo, pull, state, onShowThread }: ConversationProps) {
  const { discussion, error, write } = state
  if (!discussion) return <p className="text-sm text-neutral-500">{error ?? "Loading the conversation…"}</p>

  const items: Item[] = [
    ...discussion.comments.map((comment) => ({ at: comment.created_at, comment })),
    ...discussion.reviews.map((review) => ({ at: review.submitted_at ?? "", review })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const entries: Entry[] = []
  for (const item of items) {
    if ("comment" in item || item.review.body.trim()) {
      entries.push(item)
      continue
    }
    const last = entries.at(-1)
    const foldable = item.review.state === "COMMENTED"
    if (foldable && last && "quiet" in last && last.quiet[0].state === "COMMENTED" && sameAuthor(last.quiet[0], item.review))
      last.quiet.push(item.review)
    else entries.push({ quiet: [item.review] })
  }
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
          <Markdown baseUrl={pull.html_url}>{pull.body}</Markdown>
        ) : (
          <p className="text-neutral-500">No description.</p>
        )}
      </section>

      {entries.map((entry) =>
        "comment" in entry ? (
          <section key={entry.comment.id} className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            <CommentView comment={entry.comment} kind="issue-comments" write={write} />
          </section>
        ) : "review" in entry ? (
          <ReviewItem key={entry.review.id} review={entry.review} />
        ) : (
          <QuietReviews key={entry.quiet[0].id} reviews={entry.quiet} />
        ),
      )}

      {threads.length > 0 && (
        <section id={THREADS_ID} className="flex scroll-mt-4 flex-col gap-3">
          <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Review threads</h2>
          {threads.map((thread) => (
            <div key={thread.id} className="rounded-md border border-neutral-200 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => onShowThread(thread)}
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
      <Markdown baseUrl={review.url} className="mt-2">
        {review.body}
      </Markdown>
    </section>
  )
}

/** Reviews with no body: who reviewed, and how many line comments, which are under "Review threads". */
function QuietReviews({ reviews }: { reviews: SubmittedReview[] }) {
  const first = reviews[0]
  const last = reviews[reviews.length - 1]
  const comments = reviews.reduce((sum, review) => sum + review.comments.total_count, 0)
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 text-xs text-neutral-500">
      <Avatar actor={first.author} className="size-5" />
      <span className="font-medium text-neutral-900 dark:text-neutral-100">{first.author?.login ?? "ghost"}</span>
      <span className={cn("font-medium", REVIEW_COLORS[first.state])}>{REVIEW_VERBS[first.state]}</span>
      {comments > 0 && (
        <button
          type="button"
          onClick={() => document.getElementById(THREADS_ID)?.scrollIntoView({ behavior: "smooth" })}
          className="hover:underline"
        >
          {comments} line comment{comments === 1 ? "" : "s"}
        </button>
      )}
      {last.submitted_at && (
        <a href={last.url} target="_blank" rel="noreferrer" className="hover:underline">
          {timeAgo(isoTimeAgoSeconds(last.submitted_at))}
        </a>
      )}
    </div>
  )
}

const sameAuthor = (a: SubmittedReview, b: SubmittedReview) => a.author?.login === b.author?.login
