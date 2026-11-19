import type { ReviewRecord } from "@/lib/types"

const BADGE = "rounded px-1.5 py-0.5 text-xs font-medium"

export function ProvenanceBadges({ record }: { record: ReviewRecord }) {
  return (
    <>
      {record.trust === "mine" && (
        <span className={`${BADGE} bg-neutral-200 dark:bg-neutral-800`}>Yours</span>
      )}
      {record.trust === "trusted" && (
        <span className={`${BADGE} bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300`}>Trusted</span>
      )}
      {record.requested_by_author && (
        <span
          className={`${BADGE} bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300`}
          title="The pull request's author requested this review of their own change"
        >
          By PR author
        </span>
      )}
      {!record.current && (
        <span className={`${BADGE} bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400`}>
          Earlier commit
        </span>
      )}
    </>
  )
}
