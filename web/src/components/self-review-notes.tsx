import { useState } from "react"
import { buttonClass, inputClass, linkButtonClass, noteClass as NOTE, secondaryButtonClass } from "@/components/ui"
import { cn } from "@/lib/utils"

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
