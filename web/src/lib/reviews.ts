// Choosing which cached review to show on a pull request.

import type { DiffLineAnnotation } from "@pierre/diffs"
import type { AnalyzedFile, Category, Finding, Review, ReviewRecord, Severity } from "@/lib/types"

export const SEVERITY_ORDER: Severity[] = ["blocker", "major", "minor", "nit"]

export const CATEGORY_LABELS: Record<Category, string> = {
  bug: "bug",
  security: "security",
  performance: "performance",
  design: "design",
  convention: "convention",
  test: "tests",
  question: "question",
  suspicious: "suspicious content",
}

export const bySeverity = (a: Finding, b: Finding) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)

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

/** How many of the pull request's reviewable hunks an earlier review still places in a section. */
export function coverage(record: ReviewRecord, files: AnalyzedFile[]) {
  const placed = new Set(record.review.sections.flatMap((s) => s.hunk_ids))
  const ids = files.flatMap((f) => f.analysis.hunks.filter((h) => !h.collapsible).map((h) => h.id))
  const covered = ids.filter((id) => placed.has(id)).length
  return { covered, total: ids.length }
}

export const shortSha = (sha: string) => sha.slice(0, 7)

/** Each finding on a file, under the last line it covers. */
export function findingAnnotations(findings: Finding[], path: string): DiffLineAnnotation<Finding>[] {
  return findings
    .filter((f) => f.path === path)
    .map((f) => ({ side: f.side === "new" ? "additions" : "deletions", lineNumber: f.end_line, metadata: f }))
}

/** Each hunk note, at the top of its hunk. */
export function hunkNoteAnnotations(file: AnalyzedFile, review: Review | undefined): DiffLineAnnotation<string>[] {
  const annotations: DiffLineAnnotation<string>[] = []
  for (const hunk of file.analysis.hunks) {
    const note = review?.hunk_notes[hunk.id]
    if (!note) continue
    annotations.push(
      hunk.new_lines > 0
        ? { side: "additions", lineNumber: hunk.new_start, metadata: note }
        : { side: "deletions", lineNumber: hunk.old_start, metadata: note },
    )
  }
  return annotations
}
