import { Markdown } from "@/components/markdown"
import { useSidebarNavigate } from "@/lib/sidebar"
import { SeverityBadge } from "@/components/severity-badge"
import { linkButtonClass, noteClass as NOTE } from "@/components/ui"
import { CATEGORY_LABELS, bySeverity } from "@/lib/reviews"
import type { FindingStatus } from "@/lib/notes"
import { cn, scrollToHunk } from "@/lib/utils"
import type { Finding } from "@/lib/types"

/** What you can do with a finding. */
export type FindingActions = {
  status: FindingStatus
  /** Starts a comment from the finding, to edit and send to GitHub or your agent. */
  onAccept: () => void
  onDismiss: () => void
  /** Undoes a dismissal. */
  onRestore: () => void
}

type FindingNoteProps = {
  finding: Finding
  /** Where relative links in the text would resolve; links are shown as text. */
  baseUrl: string
  actions?: FindingActions
}

/** A finding in the diff, under the lines it's about. */
export function FindingNote({ finding, baseUrl, actions }: FindingNoteProps) {
  const dismissed = actions?.status === "dismissed"
  return (
    <div className={cn(NOTE, dismissed && "opacity-50")}>
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="flex-1 font-medium">{finding.title}</span>
        <span className="text-xs text-neutral-500">{CATEGORY_LABELS[finding.category]}</span>
        {dismissed && <span className="text-xs text-neutral-500">· dismissed</span>}
      </div>
      <Markdown baseUrl={baseUrl} links={false} className="mt-1">
        {finding.body}
      </Markdown>
      {finding.suggestion && (
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-900">
          {finding.suggestion}
        </pre>
      )}
      {actions && (
        <div className="mt-2 flex gap-3 text-xs">
          {dismissed ? (
            <button type="button" onClick={actions.onRestore} className={linkButtonClass}>
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={actions.onAccept}
                title="Start a comment from this finding, for GitHub or your agent"
                className={linkButtonClass}
              >
                Accept
              </button>
              <button type="button" onClick={actions.onDismiss} className={linkButtonClass}>
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

type FindingListProps = {
  findings: Finding[]
  /** What you did with each. */
  statusOf?: (finding: Finding) => FindingStatus
  /** Shown when there are no findings. */
  empty: string
}

/** Every finding, most severe first; choosing one scrolls to it. */
export function FindingList({ findings, statusOf, empty }: FindingListProps) {
  const navigate = useSidebarNavigate()
  if (findings.length === 0) return <p className="text-sm text-neutral-500">{empty}</p>
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Findings</h2>
      {[...findings].sort(bySeverity).map((f) => {
        const status = statusOf?.(f) ?? "pending"
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              navigate()
              scrollToHunk(f.hunk_id)
            }}
            className={cn(
              "flex flex-col gap-1 rounded-md p-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900",
              status === "dismissed" && "opacity-50",
            )}
          >
            <span className="flex items-center gap-2">
              <SeverityBadge severity={f.severity} />
              <span className="text-xs text-neutral-500">{CATEGORY_LABELS[f.category]}</span>
              {status === "agent" && <span className="text-xs text-violet-700 dark:text-violet-300">in your agent notes</span>}
              {status === "github" && <span className="text-xs text-green-700 dark:text-green-400">on GitHub</span>}
              {status === "dismissed" && <span className="text-xs text-neutral-500">dismissed</span>}
            </span>
            <span className={cn(status === "dismissed" && "line-through")}>{f.title}</span>
            <span className="truncate font-mono text-xs text-neutral-500">
              {f.path}:{f.start_line}
            </span>
          </button>
        )
      })}
    </div>
  )
}
