import { timeAgo } from "@/lib/utils"
import type { ReviewRecord } from "@/lib/types"

type ReviewSummaryProps = {
  record: ReviewRecord
}

export function ReviewSummary({ record }: ReviewSummaryProps) {
  const { review } = record
  return (
    <section className="mb-6 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">
        Guided review by {record.model} · requested by {record.requested_by.login} {timeAgo(record.created_at)}
      </p>
      <p className="mt-2">{review.summary}</p>
      {review.questions.length > 0 && (
        <>
          <h2 className="mt-4 text-sm font-medium">Questions for the author</h2>
          <ul className="mt-1 list-disc pl-5 text-sm text-neutral-600 dark:text-neutral-400">
            {review.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
