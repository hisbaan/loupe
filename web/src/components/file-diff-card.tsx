import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import { useState, type ReactNode } from "react"
import { diffViewOptions, useDiffSettings } from "@/lib/diff-settings"
import { KIND_LABELS, planCollapse, toUnifiedPatch } from "@/lib/patch"
import { fileAnchor } from "@/lib/utils"
import type { AnalyzedFile, HunkAnalysis } from "@/lib/types"

type FileDiffCardProps<T> = {
  file: AnalyzedFile
  annotations?: DiffLineAnnotation<T>[]
  renderAnnotation?: (metadata: T) => ReactNode
  /** Shows a "+" in the gutter to comment on a line or dragged range. */
  onAddComment?: (range: SelectedLineRange) => void
  /** The file on GitHub. */
  githubUrl?: string
}

export function FileDiffCard<T>({ file, annotations, renderAnnotation, onAddComment, githubUrl }: FileDiffCardProps<T>) {
  const [chosenExpanded, setExpanded] = useState(false)
  const settings = useDiffSettings()
  const { analysis } = file
  const patch = toUnifiedPatch(file)
  const plan = planCollapse(file)
  const notes = analysis.hunks.flatMap((h) => h.notes)
  // A comment on a collapsed hunk would be invisible, so show everything.
  const forced =
    annotations?.some(
      (a) => analysis.collapsible || analysis.hunks.some((h) => h.collapsible && inHunk(h, a.side, a.lineNumber)),
    ) ?? false
  const expanded = chosenExpanded || forced

  const wholeFileCollapsed = analysis.collapsible && !expanded
  const partiallyCollapsed = !analysis.collapsible && plan.reducedPatch != null && !expanded

  let summary: string | null = null
  if (analysis.collapsible) {
    summary = `Collapsed: ${KIND_LABELS[analysis.kind ?? analysis.hunks[0]?.kind ?? "code"]}`
  } else if (plan.hiddenCount > 0) {
    const hunks = plan.hiddenCount === 1 ? "1 hunk" : `${plan.hiddenCount} hunks`
    summary = `${hunks} hidden: ${plan.hiddenKinds.map((k) => KIND_LABELS[k]).join(", ")}`
  }

  return (
    <section
      id={fileAnchor(file.filename)}
      className="scroll-mt-4 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800"
    >
      {(summary || analysis.kind || notes.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          {analysis.kind && (
            <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-medium dark:bg-neutral-800">{KIND_LABELS[analysis.kind]}</span>
          )}
          {summary && <span className="text-neutral-500">{summary}</span>}
          {summary && !forced && (
            <button type="button" onClick={() => setExpanded((e) => !e)} className="text-blue-600 hover:underline dark:text-blue-400">
              {expanded ? "Hide" : "Show"}
            </button>
          )}
          {notes.map((note) => (
            <span key={note} className="w-full text-amber-700 dark:text-amber-400">
              ⚠ {note}
            </span>
          ))}
        </div>
      )}

      {patch == null ? (
        <div className="px-4 py-3 text-sm">
          <span className="font-mono">{file.filename}</span>
          <span className="ml-2 text-neutral-500">
            {file.status === "renamed" ? `Renamed from ${file.previous_filename}` : "Binary or too large to display"}
          </span>
        </div>
      ) : (
        <PatchDiff<T, undefined>
          // Remount when switching patches so the diff re-parses cleanly.
          key={partiallyCollapsed ? "reduced" : "full"}
          patch={partiallyCollapsed ? plan.reducedPatch! : patch}
          options={{
            ...diffViewOptions(settings),
            collapsed: wholeFileCollapsed,
            enableGutterUtility: onAddComment != null,
            onGutterUtilityClick: onAddComment,
          }}
          lineAnnotations={annotations}
          renderAnnotation={renderAnnotation && ((annotation) => renderAnnotation(annotation.metadata as T))}
          renderHeaderMetadata={
            githubUrl
              ? () => (
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-neutral-500 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
                  >
                    GitHub ↗
                  </a>
                )
              : undefined
          }
        />
      )}
    </section>
  )
}

function inHunk(hunk: HunkAnalysis, side: "additions" | "deletions", line: number) {
  const [start, count] = side === "additions" ? [hunk.new_start, hunk.new_lines] : [hunk.old_start, hunk.old_lines]
  return line >= start && line < start + count
}
