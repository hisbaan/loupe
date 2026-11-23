import { useState } from "react"
import { SeverityBadge } from "@/components/severity-badge"
import { buttonClass, inputClass, linkButtonClass, noteClass as NOTE, secondaryButtonClass } from "@/components/ui"
import type { FindingStatus } from "@/lib/self-review"
import { cn } from "@/lib/utils"
import type { Finding } from "@/lib/types"

type FindingNoteProps = {
  finding: Finding
  status: FindingStatus
  body: string
  onDecide: (decision: { status: "accepted" | "dismissed"; body?: string } | null) => void
}

/** A model finding in the diff, with accept / edit / dismiss. */
export function FindingNote({ finding, status, body, onDecide }: FindingNoteProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body)
  const edited = body !== finding.body

  return (
    <div className={cn(NOTE, status === "dismissed" && "opacity-50")}>
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="flex-1 font-medium">{finding.title}</span>
        {status !== "pending" && <span className="text-xs text-neutral-500">{status}</span>}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className={inputClass} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onDecide({ status: "accepted", body: draft.trim() === finding.body ? undefined : draft.trim() })
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
          <p className="mt-1 whitespace-pre-wrap">{body}</p>
          {edited && <p className="mt-1 text-xs text-neutral-500">Edited by you</p>}
          {finding.suggestion && (
            <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-900">
              {finding.suggestion}
            </pre>
          )}
          <div className="mt-2 flex gap-3 text-xs">
            {status !== "accepted" && (
              <button type="button" onClick={() => onDecide({ status: "accepted", body: edited ? body : undefined })} className={linkButtonClass}>
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
              <button type="button" onClick={() => onDecide({ status: "dismissed", body: edited ? body : undefined })} className={linkButtonClass}>
                Dismiss
              </button>
            )}
            {status !== "pending" && (
              <button type="button" onClick={() => onDecide(null)} className={linkButtonClass}>
                Undo
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

type CommentNoteProps = {
  body: string
  /** A new comment starts in edit mode. */
  isNew?: boolean
  onSave: (body: string) => void
  onDelete: () => void
}

/** The user's own comment in the diff. */
export function CommentNote({ body, isNew = false, onSave, onDelete }: CommentNoteProps) {
  const [editing, setEditing] = useState(isNew)
  const [draft, setDraft] = useState(body)

  if (editing) {
    return (
      <div className={NOTE}>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="What should change here?"
          className={cn(inputClass, "w-full")}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              onSave(draft.trim())
              setEditing(false)
            }}
            className={buttonClass}
          >
            Save comment
          </button>
          <button type="button" onClick={() => (isNew ? onDelete() : setEditing(false))} className={secondaryButtonClass}>
            Cancel
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={NOTE}>
      <div className="flex items-start gap-2">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
          you
        </span>
        <p className="flex-1 whitespace-pre-wrap">{body}</p>
      </div>
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" onClick={() => setEditing(true)} className={linkButtonClass}>
          Edit
        </button>
        <button type="button" onClick={onDelete} className={linkButtonClass}>
          Delete
        </button>
      </div>
    </div>
  )
}
