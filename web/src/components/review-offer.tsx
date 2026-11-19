import { ProvenanceBadges } from "@/components/provenance-badges"
import { buttonClass } from "@/components/ui"
import { coverage, shortSha } from "@/lib/reviews"
import { timeAgo } from "@/lib/utils"
import type { AnalyzedFile, ReviewRecord } from "@/lib/types"

type ReviewOfferProps = {
  record: ReviewRecord
  files: AnalyzedFile[]
  onUse: () => void
  onDismiss: () => void
}

/** "@alice already generated a guided review. Use it?" */
export function ReviewOffer({ record, files, onUse, onDismiss }: ReviewOfferProps) {
  const who = record.trust === "mine" ? "You" : `@${record.requested_by.login}`
  const { covered, total } = coverage(record, files)
  return (
    <section className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/40">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span>
            {who} generated a guided review {timeAgo(record.created_at)} with {record.model}
            {record.current ? "." : ` for an earlier commit (${shortSha(record.head_sha)}).`}
          </span>
          <ProvenanceBadges record={record} />
        </p>
        {!record.current && (
          <p className="mt-1 text-neutral-500">
            It still covers {covered} of {total} changes; the rest are new since then.
          </p>
        )}
      </div>
      <button type="button" onClick={onUse} className={buttonClass}>
        {record.current ? "Use it" : "Show it"}
      </button>
      <button type="button" onClick={onDismiss} className="text-neutral-500 hover:underline">
        Not now
      </button>
    </section>
  )
}
