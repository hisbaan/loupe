import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs"
import type { ReactNode } from "react"
import { FileDiffCard } from "@/components/file-diff-card"
import { KIND_LABELS, sliceHunks, type CollapsedGroup, type FileSlice } from "@/lib/patch"
import type { AnalyzedFile, HunkAnalysis } from "@/lib/types"

/** Cards shown together, optionally under a heading. */
export type DiffGroup = { key: string; id?: string; header?: ReactNode; slices: FileSlice[] }

export type DiffColumnProps<T> = {
  groups: DiffGroup[]
  /** What the pre-pass collapsed, shown folded at the bottom. */
  collapsed: CollapsedGroup[]
  /** Every annotation on the file; each goes to the card showing its line. */
  annotationsFor: (file: AnalyzedFile) => DiffLineAnnotation<T>[]
  renderAnnotation: (metadata: T) => ReactNode
  onAddComment?: (file: AnalyzedFile, range: SelectedLineRange) => void
  githubUrl: (file: AnalyzedFile) => string
}

/** The diff as cards: the groups in order, then the collapsed changes. */
export function DiffColumn<T>({
  groups,
  collapsed,
  annotationsFor,
  renderAnnotation,
  onAddComment,
  githubUrl,
}: DiffColumnProps<T>) {
  const card = (slice: FileSlice, folded: boolean) => {
    const { file } = slice
    return (
      <FileDiffCard
        key={sliceKey(slice)}
        slice={slice}
        collapsed={folded}
        annotations={annotationsFor(file).filter((a) => onCard(slice, a))}
        renderAnnotation={renderAnnotation}
        onAddComment={onAddComment && ((range) => onAddComment(file, range))}
        githubUrl={githubUrl(file)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <div key={group.key} id={group.id} className="flex scroll-mt-4 flex-col gap-4">
          {group.header}
          {group.slices.map((slice) => card(slice, false))}
        </div>
      ))}
      {collapsed.length > 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Collapsed by the pre-pass</h2>
            <p className="text-sm text-neutral-500">
              Mechanical changes that rarely need a careful read. Open any of them to check.
            </p>
          </div>
          {collapsed.map((group) => (
            <div key={group.kind} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
                {KIND_LABELS[group.kind]} · {group.slices.length} {group.slices.length === 1 ? "file" : "files"}
              </h3>
              {group.slices.map((slice) => card(slice, true))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const sliceKey = (slice: FileSlice) => `${slice.file.filename}#${slice.hunkIds?.[0] ?? "all"}`

/** Whether a line annotation belongs on this card. */
function onCard(slice: FileSlice, annotation: { side: "additions" | "deletions"; lineNumber: number }) {
  if (slice.hunkIds == null) return true
  return sliceHunks(slice).some((h) => inHunk(h, annotation.side, annotation.lineNumber))
}

function inHunk(hunk: HunkAnalysis, side: "additions" | "deletions", line: number) {
  const [start, count] = side === "additions" ? [hunk.new_start, hunk.new_lines] : [hunk.old_start, hunk.old_lines]
  return line >= start && line < start + count
}
