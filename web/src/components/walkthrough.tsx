import { ImportanceBadge } from "@/components/importance-badge"
import type { GuidedReview, Importance } from "@/lib/types"

type WalkthroughProps = {
  review: GuidedReview
  onSelectHunk: (hunkId: string) => void
}

const RANK: Record<Importance, number> = { critical: 0, normal: 1, low: 2 }

export function Walkthrough({ review, onSelectHunk }: WalkthroughProps) {
  return (
    <ol className="flex flex-col gap-3">
      {review.walkthrough.map((step, i) => {
        const top = step.hunk_ids
          .map((id) => review.hunks[id]?.importance)
          .filter((x): x is Importance => x != null)
          .sort((a, b) => RANK[a] - RANK[b])[0]
        return (
          <li key={i}>
            <button
              type="button"
              onClick={() => step.hunk_ids[0] && onSelectHunk(step.hunk_ids[0])}
              className="w-full rounded-md p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="text-neutral-400">{i + 1}</span>
                {step.title}
                {top && <ImportanceBadge importance={top} className="ml-auto" />}
              </span>
              <span className="mt-1 block text-xs text-neutral-500">{step.why}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
