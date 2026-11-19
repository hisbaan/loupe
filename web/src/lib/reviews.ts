// Choosing which cached review to show on a pull request.

import type { AnalyzedFile, ReviewRecord } from "@/lib/types"

/** Shown without asking: your own current review, else an auto-load trusted one. */
export function autoSelected(reviews: ReviewRecord[]): ReviewRecord | null {
  const current = reviews.filter((r) => r.current)
  return current.find((r) => r.trust === "mine") ?? current.find((r) => r.auto_load) ?? null
}

/**
 * The newest review of earlier commits that can be updated incrementally (yours
 * or a trusted reviewer's), unless you already have a current review.
 */
export function updatableReview(reviews: ReviewRecord[]): ReviewRecord | null {
  if (reviews.some((r) => r.current && r.trust === "mine")) return null
  return reviews.find((r) => !r.current && r.trust !== "other") ?? null
}

/** How many of the pull request's reviewable hunks an earlier review still covers. */
export function coverage(record: ReviewRecord, files: AnalyzedFile[]) {
  const ids = files.flatMap((f) => f.analysis.hunks.filter((h) => !h.collapsible).map((h) => h.id))
  const covered = ids.filter((id) => id in record.review.hunks).length
  return { covered, total: ids.length }
}

export const shortSha = (sha: string) => sha.slice(0, 7)
