import { ImportanceBadge } from "@/components/importance-badge"
import type { HunkAssessment } from "@/lib/types"

export function HunkNote({ assessment }: { assessment: HunkAssessment }) {
  return (
    <div className="border-y border-neutral-200 bg-white px-3 py-2 font-sans text-sm dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-start gap-2">
        <ImportanceBadge importance={assessment.importance} />
        <span>{assessment.rationale}</span>
      </div>
      {assessment.concerns.length > 0 && (
        <ul className="mt-1 list-disc pl-14 text-amber-700 dark:text-amber-400">
          {assessment.concerns.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
