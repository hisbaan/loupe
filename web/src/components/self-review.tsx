import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs"
import { useEffect, useRef, useState } from "react"
import { FilesRead } from "@/components/files-read"
import { FindingList, FindingNote } from "@/components/finding-note"
import { GenerateControls } from "@/components/generate-controls"
import { Markdown } from "@/components/markdown"
import { ReviewColumns } from "@/components/review-columns"
import { ReviewContents, ReviewDiff } from "@/components/review-sections"
import { CommentNote } from "@/components/self-review-notes"
import { errorMessage, secondaryButtonClass } from "@/components/ui"
import { api } from "@/lib/api"
import { lineRange } from "@/lib/discussion"
import { reviewLayout } from "@/lib/review-layout"
import { shortSha } from "@/lib/reviews"
import {
  exportItems,
  exportMarkdown,
  findingBody,
  findingStatus,
  removeComment,
  setFinding,
  upsertComment,
} from "@/lib/self-review"
import { githubFileUrl, timeAgo } from "@/lib/utils"
import type { Finding, PullResponse, ReviewComment, SelfReviewNotes, SelfReviewRecord } from "@/lib/types"

type SelfReviewProps = {
  owner: string
  repo: string
  number: number
  pr: PullResponse
}

type Note = { kind: "finding"; finding: Finding } | { kind: "comment"; comment: ReviewComment; isNew: boolean }
/** @pierre/diffs distributes over union metadata types, so wrap the union. */
type Annotated = { note: Note }

const SAVE_DELAY_MS = 600

/**
 * Problems the model found, plus your own comments, to accept, edit or dismiss
 * and then export as markdown for a coding agent. Private to you.
 */
export function SelfReview({ owner, repo, number, pr }: SelfReviewProps) {
  const { pull, files } = pr
  const [records, setRecords] = useState<SelfReviewRecord[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // Local copies of notes, ahead of the server while a save is pending.
  const [notesById, setNotesById] = useState<Record<number, SelfReviewNotes>>({})
  const [draft, setDraft] = useState<ReviewComment | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const timers = useRef(new Map<number, number>())

  useEffect(() => {
    let cancelled = false
    api.selfReviews(owner, repo, number).then((r) => {
      if (!cancelled && r.ok) setRecords(r.data.self_reviews)
    })
    return () => {
      cancelled = true
    }
  }, [owner, repo, number])

  const record = records.find((r) => r.id === selectedId) ?? records.find((r) => r.current) ?? records[0] ?? null
  const notes: SelfReviewNotes = record ? (notesById[record.id] ?? record.notes) : {}

  function updateNotes(change: (notes: SelfReviewNotes) => SelfReviewNotes) {
    if (!record) return
    const id = record.id
    const next = change(notes)
    setNotesById((all) => ({ ...all, [id]: next }))
    window.clearTimeout(timers.current.get(id))
    timers.current.set(
      id,
      window.setTimeout(async () => {
        const result = await api.saveSelfReviewNotes(id, next)
        setSaveError(result.ok ? null : `Couldn't save your notes: ${result.error}`)
      }, SAVE_DELAY_MS),
    )
  }

  function addComment(path: string, range: SelectedLineRange) {
    if (!record?.current) return
    setDraft({ id: crypto.randomUUID(), path, ...lineRange(range), body: "" })
  }

  function annotationsFor(path: string): DiffLineAnnotation<Annotated>[] {
    // An earlier commit's line numbers don't match the diff on screen.
    if (!record?.current) return []
    const at = (side: Finding["side"], lineNumber: number, note: Note): DiffLineAnnotation<Annotated> => ({
      side: side === "new" ? "additions" : "deletions",
      lineNumber,
      metadata: { note },
    })
    const comments = [...(notes.comments ?? []), ...(draft ? [draft] : [])]
    return [
      ...record.review.findings
        .filter((f) => f.path === path)
        .map((f) => at(f.side, f.end_line, { kind: "finding", finding: f })),
      ...comments
        .filter((c) => c.path === path)
        .map((c) => at(c.side, c.end_line, { kind: "comment", comment: c, isNew: c.id === draft?.id })),
    ]
  }

  function renderNote({ note }: Annotated) {
    if (note.kind === "finding") {
      const { finding } = note
      return (
        <FindingNote
          finding={finding}
          baseUrl={pull.html_url}
          decision={{
            status: findingStatus(notes, finding.id),
            body: findingBody(notes, finding),
            onDecide: (decision) => updateNotes((n) => setFinding(n, finding.id, decision)),
          }}
        />
      )
    }
    const { comment, isNew } = note
    return (
      <CommentNote
        body={comment.body}
        isNew={isNew}
        onSave={(body) => {
          updateNotes((n) => upsertComment(n, { ...comment, body }))
          if (isNew) setDraft(null)
        }}
        onDelete={() => (isNew ? setDraft(null) : updateNotes((n) => removeComment(n, comment.id)))}
      />
    )
  }

  // An earlier commit's sections still group the hunks that are unchanged.
  const layout = reviewLayout(record?.review ?? null, files)

  return (
    <ReviewColumns
      aside={
        <>
          <GenerateControls
            actions={[
              {
                label: records.some((r) => r.current) ? "Run self-review again" : "Run self-review",
                run: (job, onProgress) =>
                  api.generateSelfReview(owner, repo, number, job, (progress) => {
                    if (progress.type === "done") {
                      setRecords((rs) => [progress.record, ...rs])
                      setSelectedId(progress.record.id)
                    }
                    onProgress(progress)
                  }),
              },
            ]}
          />
          {record && (
            <ExportPanel
              onMarkdown={() => exportMarkdown({ owner, repo, pull, record, notes, files })}
              filename={`review-${repo}-${pull.number}-${shortSha(record.head_sha)}.md`}
              counts={exportItems(record, notes)}
            />
          )}
          {record && <ReviewContents review={record.review} layout={layout} />}
          {record && (
            <FindingList
              findings={record.review.findings}
              statusOf={(f) => findingStatus(notes, f.id)}
              empty="No problems found."
            />
          )}
          {records.length > 1 && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Earlier runs</span>
              <select
                value={record?.id}
                onChange={(e) => setSelectedId(Number(e.target.value))}
                className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"
              >
                {records.map((r) => (
                  <option key={r.id} value={r.id}>
                    {timeAgo(r.created_at)} · {r.model}
                    {r.current ? "" : ` · ${shortSha(r.head_sha)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      }
    >
      {record ? (
        <section className="mb-6 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500">
            Self-review by {record.model} ({record.effort}) {timeAgo(record.created_at)} ·{" "}
            {plural(record.review.findings.length, "finding")} · only you can see this · <FilesRead files={record.files_read} />
          </p>
          {!record.current && (
            <p className="mt-2 text-sm text-amber-600">
              This self-review is of an earlier commit ({shortSha(record.head_sha)}), so its findings aren't shown in the
              diff and exports leave out code snippets. Run it again for the latest commit.
            </p>
          )}
          <Markdown baseUrl={pull.html_url} links={false} className="mt-2">
            {record.review.summary}
          </Markdown>
          {saveError && <p className="mt-2 text-sm text-red-600">{saveError}</p>}
        </section>
      ) : (
        <section className="mb-6 rounded-md border border-neutral-200 p-4 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          A self-review looks for problems before you ask anyone else to review. Accept, edit or dismiss what it finds,
          add your own comments with the + beside any line, then export everything as instructions for your coding
          agent. Only you can see it.
        </section>
      )}
      <ReviewDiff
        review={record?.review ?? null}
        layout={layout}
        baseUrl={pull.html_url}
        annotationsFor={(file) => annotationsFor(file.filename)}
        renderAnnotation={renderNote}
        onAddComment={record?.current ? (file, range) => addComment(file.filename, range) : undefined}
        githubUrl={(file) => githubFileUrl(pull, file)}
      />
    </ReviewColumns>
  )
}

type ExportPanelProps = {
  onMarkdown: () => string
  filename: string
  counts: { comments: unknown[]; findings: unknown[] }
}

function ExportPanel({ onMarkdown, filename, counts }: ExportPanelProps) {
  const [message, setMessage] = useState<string | null>(null)
  const total = counts.comments.length + counts.findings.length

  async function copy() {
    try {
      await navigator.clipboard.writeText(onMarkdown())
      setMessage("Copied")
    } catch (err) {
      setMessage(errorMessage(err))
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([onMarkdown()], { type: "text/markdown" }))
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-500">
        Export {plural(total, "item")} for your coding agent ({counts.comments.length} yours,{" "}
        {plural(counts.findings.length, "finding")}; dismissed findings are left out).
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={copy} className={secondaryButtonClass}>
          Copy markdown
        </button>
        <button type="button" onClick={download} className={secondaryButtonClass}>
          Download
        </button>
      </div>
      {message && <p className="text-xs text-neutral-500">{message}</p>}
    </div>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
