import { useState } from "react"
import { Markdown } from "@/components/markdown"
import { useSidebarNavigate } from "@/lib/sidebar"
import { SeverityBadge } from "@/components/severity-badge"
import { buttonClass, inputClass, linkButtonClass, noteClass as NOTE, secondaryButtonClass } from "@/components/ui"
import { CATEGORY_LABELS, bySeverity } from "@/lib/reviews"
import type { FindingStatus } from "@/lib/self-review"
import { cn, scrollToHunk } from "@/lib/utils"
import type { Finding } from "@/lib/types"

/** Your decision on a self-review finding. */
export type FindingDecision = {
  status: FindingStatus
  /** The body, as you edited it if you did. */
  body: string
  onDecide: (decision: { status: "accepted" | "dismissed"; body?: string } | null) => void
}

type FindingNoteProps = {
  finding: Finding
  /** Where relative links in the text would resolve; links are shown as text. */
  baseUrl: string
  /** Self-reviews only: accept, edit or dismiss. */
  decision?: FindingDecision
}

/** A finding in the diff, under the lines it's about. */
export function FindingNote({ finding, baseUrl, decision }: FindingNoteProps) {
  const [editing, setEditing] = useState(false)
  const body = decision?.body ?? finding.body
  const [draft, setDraft] = useState(body)
  const status = decision?.status ?? "pending"
  const edited = body !== finding.body

  return (
    <div className={cn(NOTE, status === "dismissed" && "opacity-50")}>
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="flex-1 font-medium">{finding.title}</span>
        <span className="text-xs text-neutral-500">{CATEGORY_LABELS[finding.category]}</span>
        {status !== "pending" && <span className="text-xs text-neutral-500">· {status}</span>}
      </div>
      {editing && decision ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className={inputClass} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                decision.onDecide({ status: "accepted", body: draft.trim() === finding.body ? undefined : draft.trim() })
                setEditing(false)
              }}
              className={buttonClass}
            >
              Save and accept
            </button>
            <button type="button" onClick={() => setEditing(false)} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <Markdown baseUrl={baseUrl} links={false} className="mt-1">
            {body}
          </Markdown>
          {edited && <p className="mt-1 text-xs text-neutral-500">Edited by you</p>}
          {finding.suggestion && (
            <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-900">
              {finding.suggestion}
            </pre>
          )}
          {decision && (
            <div className="mt-2 flex gap-3 text-xs">
              {status !== "accepted" && (
                <button
                  type="button"
                  onClick={() => decision.onDecide({ status: "accepted", body: edited ? body : undefined })}
                  className={linkButtonClass}
                >
                  Accept
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(body)
                  setEditing(true)
                }}
                className={linkButtonClass}
              >
                Edit
              </button>
              {status !== "dismissed" && (
                <button
                  type="button"
                  onClick={() => decision.onDecide({ status: "dismissed", body: edited ? body : undefined })}
                  className={linkButtonClass}
                >
                  Dismiss
                </button>
              )}
              {status !== "pending" && (
                <button type="button" onClick={() => decision.onDecide(null)} className={linkButtonClass}>
                  Undo
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

type FindingListProps = {
  findings: Finding[]
  /** Self-reviews: your decision on each. */
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
              {status === "accepted" && <span className="text-xs text-green-700 dark:text-green-400">accepted</span>}
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
