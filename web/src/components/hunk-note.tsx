import { Markdown } from "@/components/markdown"
import { noteClass } from "@/components/ui"

/** The review's note on a hunk, shown at its top. */
export function HunkNote({ note, baseUrl }: { note: string; baseUrl: string }) {
  return (
    <div className={noteClass}>
      <div className="flex items-start gap-2">
        <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
          note
        </span>
        <Markdown baseUrl={baseUrl} links={false} className="min-w-0 flex-1">
          {note}
        </Markdown>
      </div>
    </div>
  )
}
