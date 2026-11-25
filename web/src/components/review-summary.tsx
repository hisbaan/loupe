import { FilesRead } from "@/components/files-read"
import { Markdown } from "@/components/markdown"
import { ProvenanceBadges } from "@/components/provenance-badges"
import { coverage, shortSha } from "@/lib/reviews"
import { timeAgo } from "@/lib/utils"
import type { AnalyzedFile, ReviewRecord } from "@/lib/types"

type ReviewSummaryProps = {
  record: ReviewRecord
  files: AnalyzedFile[]
  /** The pull request on GitHub; links in model text are shown as text. */
  baseUrl: string
}

/** The review's overview and questions, with who made it and how. */
export function ReviewSummary({ record, files, baseUrl }: ReviewSummaryProps) {
  const { review } = record
  const { covered, total } = coverage(record, files)
  return (
    <section className="mb-8 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>
          Guided review by {record.model} ({record.effort}) · requested by @{record.requested_by.login}{" "}
          {timeAgo(record.created_at)}
          {record.updated_from &&
            ` · updated from @${record.updated_from.login}'s review of ${shortSha(record.updated_from.head_sha)}`}
          {" · "}
        </span>
        <FilesRead files={record.files_read} />
        <ProvenanceBadges record={record} />
      </p>
      {!record.current && (
        <p className="mt-2 text-sm text-amber-600">
          This review is of an earlier commit ({shortSha(record.head_sha)}). It covers {covered} of {total} changes;
          the rest are under "Not in this review".
        </p>
      )}
      <h2 className="mt-3 text-sm font-medium">Overview</h2>
      <Markdown baseUrl={baseUrl} links={false} className="mt-1">
        {review.summary}
      </Markdown>
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
