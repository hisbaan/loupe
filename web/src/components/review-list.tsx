import { ProvenanceBadges } from "@/components/provenance-badges"
import { shortSha } from "@/lib/reviews"
import { cn, timeAgo } from "@/lib/utils"
import type { ReviewRecord } from "@/lib/types"

type ReviewListProps = {
  reviews: ReviewRecord[]
  selectedId: number | null
  onSelect: (record: ReviewRecord) => void
}

/** Every cached review of this pull request, to switch between them. */
export function ReviewList({ reviews, selectedId, onSelect }: ReviewListProps) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Reviews</h2>
      {reviews.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onSelect(r)}
          className={cn(
            "flex flex-col gap-1 rounded-md p-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900",
            r.id === selectedId && "bg-neutral-100 dark:bg-neutral-900",
          )}
        >
          <span>
            @{r.requested_by.login} <span className="text-neutral-500">· {timeAgo(r.created_at)}</span>
          </span>
          <span className="truncate text-xs text-neutral-500">
            {r.model}
            {!r.current && ` · ${shortSha(r.head_sha)}`}
          </span>
          <span className="flex flex-wrap gap-1">
            <ProvenanceBadges record={r} />
          </span>
        </button>
      ))}
    </div>
  )
}
