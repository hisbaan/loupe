import { PatchDiff } from "@pierre/diffs/react"
import { useState } from "react"
import { KIND_LABELS, planCollapse, toUnifiedPatch } from "@/lib/patch"
import type { AnalyzedFile } from "@/lib/types"

type FileDiffCardProps = {
  file: AnalyzedFile
}

export function FileDiffCard({ file }: FileDiffCardProps) {
  const [expanded, setExpanded] = useState(false)
  const { analysis } = file
  const patch = toUnifiedPatch(file)
  const plan = planCollapse(file)
  const notes = analysis.hunks.flatMap((h) => h.notes)

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
    <section className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      {(summary || analysis.kind || notes.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          {analysis.kind && (
            <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-medium dark:bg-neutral-800">{KIND_LABELS[analysis.kind]}</span>
          )}
          {summary && <span className="text-neutral-500">{summary}</span>}
          {summary && (
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
        <PatchDiff
          // Remount when switching patches so the diff re-parses cleanly.
          key={partiallyCollapsed ? "reduced" : "full"}
          patch={partiallyCollapsed ? plan.reducedPatch! : patch}
          options={{ diffStyle: "split", themeType: "system", collapsed: wholeFileCollapsed, stickyHeader: true }}
        />
      )}
    </section>
  )
}
