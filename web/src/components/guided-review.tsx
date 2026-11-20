import { useEffect, useState } from "react"
import { FileDiffCard } from "@/components/file-diff-card"
import { GenerateControls, type GenerateAction } from "@/components/generate-controls"
import { HunkNote } from "@/components/hunk-note"
import { ReviewColumns } from "@/components/review-columns"
import { ReviewList } from "@/components/review-list"
import { ReviewOffer } from "@/components/review-offer"
import { ReviewSummary } from "@/components/review-summary"
import { Walkthrough } from "@/components/walkthrough"
import { api } from "@/lib/api"
import { assessmentAnnotations, autoSelected, shortSha, updatableReview } from "@/lib/reviews"
import { fileAnchor } from "@/lib/utils"
import type { PullResponse, ReviewRecord } from "@/lib/types"

type GuidedReviewProps = {
  owner: string
  repo: string
  number: number
  pr: PullResponse
}

export function GuidedReview({ owner, repo, number, pr }: GuidedReviewProps) {
  const { files } = pr
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

  const fileByHunk = new Map(files.flatMap((f) => f.analysis.hunks.map((h) => [h.id, f.filename] as const)))
  function selectHunk(hunkId: string) {
    const filename = fileByHunk.get(hunkId)
    if (filename) document.getElementById(fileAnchor(filename))?.scrollIntoView({ behavior: "smooth" })
  }

  const generate =
    (basedOn?: number): GenerateAction["run"] =>
    (credential, model, onProgress) =>
      api.generateReview(owner, repo, number, { credential, model, based_on: basedOn }, (progress) => {
        if (progress.type === "done") addReview(progress.record)
        onProgress(progress)
      })
  const hasMine = reviews.some((r) => r.current && r.trust === "mine")
  const updateFrom = updatableReview(reviews)
  const actions: GenerateAction[] = [{ label: hasMine ? "Regenerate review" : "Generate guided review", run: generate() }]
  if (updateFrom) {
    actions.push({
      label: `Update ${updateFrom.trust === "mine" ? "your" : `@${updateFrom.requested_by.login}'s`} review of ${shortSha(updateFrom.head_sha)}`,
      title: "Keeps assessments of unchanged hunks and reviews only what's new",
      secondary: true,
      run: generate(updateFrom.id),
    })
  }

  return (
    <ReviewColumns
      aside={
        <>
          <GenerateControls actions={actions} />
          {record && <Walkthrough review={record.review} onSelectHunk={selectHunk} />}
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
      {record && <ReviewSummary record={record} files={files} />}
      <div className="flex flex-col gap-4">
        {files.map((file) => (
          <FileDiffCard
            key={file.filename}
            file={file}
            annotations={assessmentAnnotations(file, record?.review.hunks)}
            renderAnnotation={(assessment) => <HunkNote assessment={assessment} />}
          />
        ))}
      </div>
    </ReviewColumns>
  )
}

const trustRank = (r: ReviewRecord) => ({ mine: 0, trusted: 1, other: 2 })[r.trust]
