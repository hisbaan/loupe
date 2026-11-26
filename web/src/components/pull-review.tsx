import type { DiffLineAnnotation } from "@pierre/diffs"
import { useEffect, useState } from "react"
import { AgentNoteView } from "@/components/agent-note"
import { AgentPanel } from "@/components/agent-panel"
import { CommentComposer, type GitHubTarget } from "@/components/comment-composer"
import { FindingList, FindingNote } from "@/components/finding-note"
import { GenerateControls, type GenerateAction } from "@/components/generate-controls"
import { HunkNote } from "@/components/hunk-note"
import { ReviewColumns } from "@/components/review-columns"
import { ReviewList } from "@/components/review-list"
import { ReviewOffer } from "@/components/review-offer"
import { ReviewContents, ReviewDiff } from "@/components/review-sections"
import { ReviewSummary } from "@/components/review-summary"
import { ThreadView, type DraftLineComment } from "@/components/review-thread"
import { noteClass } from "@/components/ui"
import { api } from "@/lib/api"
import { lineRange, threadPlacements, type DiscussionState } from "@/lib/discussion"
import {
  findingDraft,
  findingKey,
  findingStatus,
  hunkAt,
  isPlaced,
  snippet,
  useAgentNotes,
  useDestination,
} from "@/lib/notes"
import { reviewLayout } from "@/lib/review-layout"
import { autoSelected, findingAnnotations, hunkNoteAnnotations, shortSha, updatableReview } from "@/lib/reviews"
import { githubFileUrl } from "@/lib/utils"
import type { AgentNote, AnalyzedFile, Finding, LineSide, PullResponse, ReviewRecord, ReviewThread } from "@/lib/types"

type PullReviewProps = {
  owner: string
  repo: string
  number: number
  pr: PullResponse
  discussion: DiscussionState
}

/** A comment being written: on lines you picked, or starting from a finding. */
type Draft = { range: DraftLineComment; body?: string; finding?: Finding }

type Note =
  | { kind: "note"; note: string }
  | { kind: "finding"; finding: Finding }
  | { kind: "thread"; thread: ReviewThread }
  | { kind: "agent"; agentNote: AgentNote }
  | { kind: "draft"; draft: Draft }
/** @pierre/diffs distributes over union metadata types, so wrap the union. */
type Annotated = { note: Note }

const diffSide = (side: LineSide) => (side === "old" ? ("deletions" as const) : ("additions" as const))

/**
 * The pull request's review: the generated review, GitHub's threads, and your
 * private notes for your coding agent, in one diff. Each new comment goes to
 * GitHub or to your agent; the choice sticks per pull request.
 */
export function PullReview({ owner, repo, number, pr, discussion }: PullReviewProps) {
  const { pull, files } = pr
  const [draft, setDraft] = useState<Draft | null>(null)
  const [reviews, setReviews] = useState<ReviewRecord[]>([])
  // null: nothing chosen yet, so fall back to the automatic choice.
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [offerDismissed, setOfferDismissed] = useState(false)
  const notes = useAgentNotes(owner, repo, number)
  const loaded = discussion.discussion
  // Your own pull request starts with notes for your agent; others' with GitHub.
  const [destination, setDestination] = useDestination(
    owner,
    repo,
    number,
    (loaded?.viewer_did_author ?? pull.draft) ? "agent" : "github",
  )

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

  // A finding's (or note's) line numbers only hold while its hunk is unchanged.
  const hunkIds = new Set(files.flatMap((f) => f.analysis.hunks.map((h) => h.id)))
  const findings = record?.review.findings.filter((f) => hunkIds.has(f.hunk_id)) ?? []
  // Accepted findings show as the note or thread they became.
  const shownFindings = findings.filter((f) => {
    const status = findingStatus(notes, f)
    return (status === "pending" || status === "dismissed") && f !== draft?.finding
  })
  const placedNotes = notes.notes.filter((n) => isPlaced(n, hunkIds, pull.head.sha))

  const generate =
    (basedOn?: number): GenerateAction["run"] =>
    (job, onProgress) =>
      api.generateReview(owner, repo, number, { ...job, based_on: basedOn }, (progress) => {
        if (progress.type === "done") addReview(progress.record)
        onProgress(progress)
      })
  // GitHub comments need the diff on screen to be the pull request's current one.
  const canComment = loaded != null && loaded.head_sha === pull.head.sha

  function annotationsFor(file: AnalyzedFile): DiffLineAnnotation<Annotated>[] {
    const wrap = (note: Note): Annotated => ({ note })
    return [
      ...hunkNoteAnnotations(file, record?.review).map((a) => ({ ...a, metadata: wrap({ kind: "note", note: a.metadata }) })),
      ...findingAnnotations(shownFindings, file.filename).map((a) => ({
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
      ...placedNotes
        .filter((n) => n.path === file.filename)
        .map((n) => ({ side: diffSide(n.side), lineNumber: n.end_line, metadata: wrap({ kind: "agent", agentNote: n }) })),
      ...(draft?.range.path === file.filename
        ? [{ side: diffSide(draft.range.side), lineNumber: draft.range.end_line, metadata: wrap({ kind: "draft", draft }) }]
        : []),
    ]
  }

  async function postComment(target: DraftLineComment, body: string, review: boolean, finding?: Finding) {
    const failed = await discussion.write(() =>
      api.addLineComment(owner, repo, number, { ...target, head_sha: pull.head.sha, body, review }),
    )
    if (failed != null) return failed
    setDraft(null)
    return finding ? notes.decide(findingKey(finding), "github") : null
  }

  async function addNote(target: DraftLineComment, body: string, finding?: Finding) {
    const file = files.find((f) => f.filename === target.path)
    const failed = await notes.add({
      ...target,
      head_sha: pull.head.sha,
      hunk_id: (file && hunkAt(file, target.side, target.start_line)?.id) ?? null,
      snippet: snippet(file, target.side, target.start_line, target.end_line),
      body,
      finding_key: finding ? findingKey(finding) : null,
    })
    if (failed == null) setDraft(null)
    return failed
  }

  /** Into your pending GitHub review, then out of your notes. */
  async function moveToGitHub(note: AgentNote) {
    const { path, side, start_line, end_line } = note
    const failed = await discussion.write(() =>
      api.addLineComment(owner, repo, number, {
        path,
        side,
        start_line,
        end_line,
        head_sha: pull.head.sha,
        body: note.body,
        review: true,
      }),
    )
    if (failed != null) return failed
    if (note.finding_key) await notes.decide(note.finding_key, "github")
    return notes.remove(note.id)
  }

  const github = (target: Draft): GitHubTarget =>
    canComment
      ? {
          available: true,
          pendingReview: loaded.pending_review != null,
          post: (body, review) => postComment(target.range, body, review, target.finding),
        }
      : {
          available: false,
          reason: loaded
            ? "New commits were pushed since this page loaded, so GitHub comments are paused until you load them."
            : "Loading the pull request's comments from GitHub…",
        }

  function renderNote({ note }: Annotated) {
    switch (note.kind) {
      case "note":
        return <HunkNote note={note.note} baseUrl={pull.html_url} />
      case "finding": {
        const { finding } = note
        const key = findingKey(finding)
        return (
          <FindingNote
            finding={finding}
            baseUrl={pull.html_url}
            actions={{
              status: findingStatus(notes, finding),
              onAccept: () =>
                setDraft({
                  range: { path: finding.path, side: finding.side, start_line: finding.start_line, end_line: finding.end_line },
                  body: findingDraft(finding),
                  finding,
                }),
              onDismiss: () => notes.decide(key, "dismissed"),
              onRestore: () => notes.decide(key, null),
            }}
          />
        )
      }
      case "thread":
        return <ThreadView thread={note.thread} write={discussion.write} className={noteClass} />
      case "agent": {
        const { agentNote } = note
        return (
          <AgentNoteView
            note={agentNote}
            baseUrl={pull.html_url}
            update={(change) => notes.update(agentNote.id, change)}
            remove={() => notes.remove(agentNote.id)}
            moveToGitHub={canComment && !agentNote.resolved ? () => moveToGitHub(agentNote) : undefined}
          />
        )
      }
      case "draft": {
        const { range, body, finding } = note.draft
        return (
          <CommentComposer
            // A new draft starts from its own text.
            key={`${range.path}:${range.side}:${range.start_line}-${range.end_line}:${finding?.id ?? ""}`}
            draft={range}
            initialBody={body}
            destination={destination}
            onDestination={setDestination}
            github={github(note.draft)}
            addNote={(text) => addNote(range, text, finding)}
            onCancel={() => setDraft(null)}
          />
        )
      }
    }
  }

  const layout = reviewLayout(record?.review ?? null, files)
  const hasMine = reviews.some((r) => r.current && r.trust === "mine")
  const updateFrom = updatableReview(reviews)
  // Your review of the latest commit is still good; generating again only makes
  // sense once new commits make it stale.
  const actions: GenerateAction[] = []
  if (!hasMine) {
    const stale = reviews.some((r) => r.trust === "mine")
    actions.push({ label: stale ? "Regenerate review" : "Generate review", run: generate() })
  }
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
          {actions.length > 0 && <GenerateControls actions={actions} />}
          <AgentPanel owner={owner} repo={repo} pull={pull} files={files} state={notes} threads={loaded?.threads ?? []} />
          {record && <ReviewContents review={record.review} layout={layout} />}
          {record && <FindingList findings={findings} statusOf={(f) => findingStatus(notes, f)} empty="No findings." />}
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
      {!record && !offer && (
        <p className="mb-6 text-sm text-neutral-500">
          Comment on any line with the + beside it: on GitHub, or as a private note for your coding agent.
        </p>
      )}
      <ReviewDiff
        review={record?.review ?? null}
        layout={layout}
        baseUrl={pull.html_url}
        annotationsFor={annotationsFor}
        renderAnnotation={renderNote}
        onAddComment={(file, range) => setDraft({ range: { path: file.filename, ...lineRange(range) } })}
        githubUrl={(file) => githubFileUrl(pull, file)}
      />
    </ReviewColumns>
  )
}

const trustRank = (r: ReviewRecord) => ({ mine: 0, trusted: 1, other: 2 })[r.trust]
