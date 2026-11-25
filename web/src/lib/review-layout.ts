// Where each change goes in the diff column: in a review's sections, most
// important first, then anything the review doesn't place, then what the
// pre-pass collapsed.

import { alignedHunks, defaultOrder, sliceHunks, splitCollapsed, type CollapsedGroup, type FileSlice } from "@/lib/patch"
import type { AnalyzedFile, Review, Section } from "@/lib/types"

export type SectionLayout = { section: Section; index: number; slices: FileSlice[] }

export type ReviewLayout = {
  sections: SectionLayout[]
  /** Reviewable changes no section places, e.g. new since an earlier commit's review. */
  rest: FileSlice[]
  collapsed: CollapsedGroup[]
}

/**
 * Lays the diff out by the review's sections. Within a section, a file's
 * hunks share one card, files in the order the section first mentions them. A
 * file whose hunks the client can't split goes whole into the first section
 * that mentions it.
 */
export function reviewLayout(review: Review | null, files: AnalyzedFile[]): ReviewLayout {
  const { review: reviewable, collapsed } = splitCollapsed(files)
  if (!review) return { sections: [], rest: defaultOrder(reviewable), collapsed }

  const sliceOf = new Map<string, FileSlice>()
  for (const slice of reviewable) for (const h of sliceHunks(slice)) sliceOf.set(h.id, slice)
  const splittable = (file: AnalyzedFile) => alignedHunks(file) != null

  const placed = new Set<string>()
  const sections = review.sections.map((section, index) => {
    const byFile = new Map<string, FileSlice>()
    for (const id of section.hunk_ids) {
      const slice = sliceOf.get(id)
      if (!slice || placed.has(id)) continue
      const { file } = slice
      if (!splittable(file)) {
        for (const h of sliceHunks(slice)) placed.add(h.id)
        byFile.set(file.filename, slice)
        continue
      }
      placed.add(id)
      const existing = byFile.get(file.filename)
      byFile.set(file.filename, { file, hunkIds: [...(existing?.hunkIds ?? []), id] })
    }
    return { section, index, slices: [...byFile.values()] }
  })

  const rest: FileSlice[] = []
  for (const slice of reviewable) {
    const hunks = sliceHunks(slice)
    const left = hunks.filter((h) => !placed.has(h.id))
    if (hunks.length === 0 || (!splittable(slice.file) && left.length === hunks.length)) rest.push(slice)
    else if (splittable(slice.file) && left.length > 0) rest.push({ file: slice.file, hunkIds: left.map((h) => h.id) })
  }
  return { sections, rest: defaultOrder(rest), collapsed }
}
