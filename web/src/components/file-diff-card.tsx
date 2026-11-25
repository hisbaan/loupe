import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import { useState, type ReactNode } from "react"
import { diffViewOptions } from "@/lib/diff-settings"
import { KIND_LABELS, sliceHunks, slicePatch, type FileSlice } from "@/lib/patch"
import { useDiffSettings } from "@/lib/settings"

type FileDiffCardProps<T> = {
  slice: FileSlice
  /** Starts folded to its header, for changes the pre-pass collapsed. */
  collapsed?: boolean
  id?: string
  annotations?: DiffLineAnnotation<T>[]
  renderAnnotation?: (metadata: T) => ReactNode
  /** Shows a "+" in the gutter to comment on a line or dragged range. */
  onAddComment?: (range: SelectedLineRange) => void
  /** The file on GitHub. */
  githubUrl?: string
}

export function FileDiffCard<T>({
  slice,
  collapsed = false,
  id,
  annotations,
  renderAnnotation,
  onAddComment,
  githubUrl,
}: FileDiffCardProps<T>) {
  const [chosenExpanded, setExpanded] = useState(false)
  const settings = useDiffSettings()
  const { file } = slice
  const patch = slicePatch(slice)
  const hunks = sliceHunks(slice)
  const notes = hunks.flatMap((h) => h.notes)
  // A comment on a folded card would be invisible, so open it.
  const forced = collapsed && (annotations?.length ?? 0) > 0
  const folded = collapsed && !chosenExpanded && !forced
  const kind = file.analysis.kind ?? (collapsed ? hunks[0]?.kind : null)

  return (
    <section
      id={id}
      className="scroll-mt-4 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800"
    >
      {(collapsed || kind || notes.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          {kind && (
            <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-medium dark:bg-neutral-800">{KIND_LABELS[kind]}</span>
          )}
          {collapsed && !forced && (
            <button type="button" onClick={() => setExpanded((e) => !e)} className="text-blue-600 hover:underline dark:text-blue-400">
              {folded ? "Show" : "Hide"}
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
          patch={patch}
          options={{
            ...diffViewOptions(settings),
            collapsed: folded,
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
