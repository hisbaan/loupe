import { useEffect, useState } from "react"
import { FileDiffCard } from "@/components/file-diff-card"
import { Layout } from "@/components/layout"
import { ReviewControls } from "@/components/review-controls"
import { ReviewList } from "@/components/review-list"
import { ReviewOffer } from "@/components/review-offer"
import { ReviewSummary } from "@/components/review-summary"
import { Walkthrough } from "@/components/walkthrough"
import { api, type ApiResult } from "@/lib/api"
import { autoSelected, updatableReview } from "@/lib/reviews"
import { fileAnchor } from "@/lib/utils"
import type { PullResponse, ReviewRecord } from "@/lib/types"

type PullPageProps = {
  owner: string
  repo: string
  number: number
}

export function PullPage({ owner, repo, number }: PullPageProps) {
  const [result, setResult] = useState<ApiResult<PullResponse> | null>(null)
  const [reviews, setReviews] = useState<ReviewRecord[]>([])
  // null: nothing chosen yet, so fall back to the automatic choice.
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [offerDismissed, setOfferDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.pull(owner, repo, number).then((r) => {
      if (!cancelled) setResult(r)
    })
    api.reviews(owner, repo, number).then((r) => {
      if (!cancelled && r.ok) setReviews(r.data.reviews)
    })
    return () => {
      cancelled = true
    }
  }, [owner, repo, number])

  if (!result) return <Layout>Loading…</Layout>
  if (!result.ok) {
    const message =
      result.status === 401
        ? "Sign in to view this pull request."
        : result.status === 404
          ? "Pull request not found, or you don't have access to it."
          : result.error
    return <Layout>{message}</Layout>
  }

  const { pull, files, truncated } = result.data
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
  const collapsedFiles = files.filter((f) => f.analysis.collapsible).length
  const fileByHunk = new Map(files.flatMap((f) => f.analysis.hunks.map((h) => [h.id, f.filename] as const)))

  function selectHunk(hunkId: string) {
    const filename = fileByHunk.get(hunkId)
    if (filename) document.getElementById(fileAnchor(filename))?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <Layout wide>
      <div className="mb-6">
        <p className="text-sm text-neutral-500">
          {owner}/{repo} #{pull.number} · {pull.user.login} wants to merge {pull.head.ref} into {pull.base.ref}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{pull.title}</h1>
        <p className="mt-2 text-sm text-neutral-500">
          {files.length} files changed
          {collapsedFiles > 0 && ` · ${collapsedFiles} collapsed`}
        </p>
        {truncated && <p className="mt-2 text-sm text-amber-600">GitHub only returns the first 3000 files of this pull request.</p>}
      </div>

      <div className="flex gap-6">
        <aside className="sticky top-4 flex h-fit max-h-[calc(100vh-2rem)] w-72 shrink-0 flex-col gap-4 overflow-y-auto">
          <ReviewControls
            owner={owner}
            repo={repo}
            number={number}
            hasReview={reviews.some((r) => r.current && r.trust === "mine")}
            updateFrom={updatableReview(reviews)}
            onReview={addReview}
          />
          {record && <Walkthrough review={record.review} onSelectHunk={selectHunk} />}
          {reviews.length > 1 && (
            <ReviewList reviews={reviews} selectedId={record?.id ?? null} onSelect={(r) => setSelectedId(r.id)} />
          )}
        </aside>

        <div className="min-w-0 flex-1">
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
              <FileDiffCard key={file.filename} file={file} assessments={record?.review.hunks} />
            ))}
          </div>
        </div>
      </div>
    </Layout>
  )
}

const trustRank = (r: ReviewRecord) => ({ mine: 0, trusted: 1, other: 2 })[r.trust]
