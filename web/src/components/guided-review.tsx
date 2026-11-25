import type { DiffLineAnnotation } from "@pierre/diffs"
import { useEffect, useState } from "react"
import { FindingList, FindingNote } from "@/components/finding-note"
import { GenerateControls, type GenerateAction } from "@/components/generate-controls"
import { HunkNote } from "@/components/hunk-note"
import { ReviewColumns } from "@/components/review-columns"
import { ReviewList } from "@/components/review-list"
import { ReviewOffer } from "@/components/review-offer"
import { ReviewContents, ReviewDiff } from "@/components/review-sections"
import { ReviewSummary } from "@/components/review-summary"
import { LineCommentForm, ThreadView, type DraftLineComment } from "@/components/review-thread"
import { noteClass } from "@/components/ui"
import { api } from "@/lib/api"
import { lineRange, threadPlacements, type DiscussionState } from "@/lib/discussion"
import { reviewLayout } from "@/lib/review-layout"
import { autoSelected, findingAnnotations, hunkNoteAnnotations, shortSha, updatableReview } from "@/lib/reviews"
import { githubFileUrl } from "@/lib/utils"
import type { AnalyzedFile, Finding, PullResponse, ReviewRecord, ReviewThread } from "@/lib/types"

type GuidedReviewProps = {
  owner: string
  repo: string
  number: number
  pr: PullResponse
  discussion: DiscussionState
}

type Note =
  | { kind: "note"; note: string }
  | { kind: "finding"; finding: Finding }
  | { kind: "thread"; thread: ReviewThread }
  | { kind: "draft"; draft: DraftLineComment }
/** @pierre/diffs distributes over union metadata types, so wrap the union. */
type Annotated = { note: Note }

export function GuidedReview({ owner, repo, number, pr, discussion }: GuidedReviewProps) {
  const { pull, files } = pr
  const [draft, setDraft] = useState<DraftLineComment | null>(null)
  const [reviews, setReviews] = useState<ReviewRecord[]>([])
  // null: nothing chosen yet, so fall back to the automatic choice.
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [offerDismissed, setOfferDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.reviews(owner, repo, number).then((r) => {
      if (!cancelled && r.ok) setReviews(r.data.reviews)
    })
    return () => {
      cancelled = true
    }
  }, [owner, repo, number])

  const record = reviews.find((r) => r.id === selectedId) ?? autoSelected(reviews)
  // Offer the best remaining review: current before earlier commits, then
  // trusted before others (the list is already newest first).
  const offer =
    record || offerDismissed
      ? null
      : ([...reviews].sort((a, b) => Number(b.current) - Number(a.current) || trustRank(a) - trustRank(b))[0] ?? null)

  function addReview(added: ReviewRecord) {
    setReviews((rs) => [added, ...rs.filter((r) => r.id !== added.id)])
    setSelectedId(added.id)
  }

  // A finding's line numbers only hold while its hunk is unchanged.
  const hunkIds = new Set(files.flatMap((f) => f.analysis.hunks.map((h) => h.id)))
  const findings = record?.review.findings.filter((f) => hunkIds.has(f.hunk_id)) ?? []

  const generate =
    (basedOn?: number): GenerateAction["run"] =>
    (job, onProgress) =>
      api.generateReview(owner, repo, number, { ...job, based_on: basedOn }, (progress) => {
        if (progress.type === "done") addReview(progress.record)
        onProgress(progress)
      })
  // Comments need the diff on screen to be the pull request's current one.
  const loaded = discussion.discussion
  const canComment = loaded != null && loaded.head_sha === pull.head.sha

  function annotationsFor(file: AnalyzedFile): DiffLineAnnotation<Annotated>[] {
    const wrap = (note: Note): Annotated => ({ note })
    return [
      ...hunkNoteAnnotations(file, record?.review).map((a) => ({ ...a, metadata: wrap({ kind: "note", note: a.metadata }) })),
      ...findingAnnotations(findings, file.filename).map((a) => ({
        ...a,
        metadata: wrap({ kind: "finding", finding: a.metadata }),
      })),
      ...(canComment
        ? threadPlacements(loaded.threads, file.filename).map(({ side, lineNumber, thread }) => ({
            side,
            lineNumber,
            metadata: wrap({ kind: "thread", thread }),
          }))
        : []),
      ...(draft?.path === file.filename
        ? [
            {
              side: draft.side === "old" ? ("deletions" as const) : ("additions" as const),
              lineNumber: draft.end_line,
              metadata: wrap({ kind: "draft", draft }),
            },
          ]
        : []),
    ]
  }

  async function postComment(target: DraftLineComment, body: string, review: boolean) {
    const failed = await discussion.write(() =>
      api.addLineComment(owner, repo, number, { ...target, head_sha: pull.head.sha, body, review }),
    )
    if (failed == null) setDraft(null)
    return failed
  }

  function renderNote({ note }: Annotated) {
    switch (note.kind) {
      case "note":
        return <HunkNote note={note.note} baseUrl={pull.html_url} />
      case "finding":
        return <FindingNote finding={note.finding} baseUrl={pull.html_url} />
      case "thread":
        return <ThreadView thread={note.thread} write={discussion.write} className={noteClass} />
      case "draft":
        return (
          <div className={noteClass}>
            <LineCommentForm
              draft={note.draft}
              pendingReview={loaded?.pending_review != null}
              post={(body, review) => postComment(note.draft, body, review)}
              onCancel={() => setDraft(null)}
            />
          </div>
        )
    }
  }

  const layout = reviewLayout(record?.review ?? null, files)
  const hasMine = reviews.some((r) => r.current && r.trust === "mine")
  const updateFrom = updatableReview(reviews)
  const actions: GenerateAction[] = [{ label: hasMine ? "Regenerate review" : "Generate guided review", run: generate() }]
  if (updateFrom) {
    actions.push({
      label: `Update ${updateFrom.trust === "mine" ? "your" : `@${updateFrom.requested_by.login}'s`} review of ${shortSha(updateFrom.head_sha)}`,
      title: "Keeps findings and notes on unchanged hunks and reviews only what's new",
      secondary: true,
      run: generate(updateFrom.id),
    })
  }

  return (
    <ReviewColumns
      aside={
        <>
          <GenerateControls actions={actions} />
          {record && <ReviewContents review={record.review} layout={layout} />}
          {record && <FindingList findings={findings} empty="No findings." />}
          {reviews.length > 1 && (
            <ReviewList reviews={reviews} selectedId={record?.id ?? null} onSelect={(r) => setSelectedId(r.id)} />
          )}
        </>
      }
    >
      {offer && (
        <ReviewOffer
          record={offer}
          files={files}
          onUse={() => setSelectedId(offer.id)}
          onDismiss={() => setOfferDismissed(true)}
        />
      )}
      {record && <ReviewSummary record={record} files={files} baseUrl={pull.html_url} />}
      <ReviewDiff
        review={record?.review ?? null}
        layout={layout}
        baseUrl={pull.html_url}
        annotationsFor={annotationsFor}
        renderAnnotation={renderNote}
        onAddComment={canComment ? (file, range) => setDraft({ path: file.filename, ...lineRange(range) }) : undefined}
        githubUrl={(file) => githubFileUrl(pull, file)}
      />
    </ReviewColumns>
  )
}

const trustRank = (r: ReviewRecord) => ({ mine: 0, trusted: 1, other: 2 })[r.trust]
