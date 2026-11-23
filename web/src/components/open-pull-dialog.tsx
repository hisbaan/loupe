import { useEffect, useRef, useState, type FormEvent } from "react"
import { buttonClass, inputClass, secondaryButtonClass } from "@/components/ui"
import { navigate } from "@/lib/router"

const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const PR_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/

type OpenPullDialogProps = {
  open: boolean
  onClose: () => void
}

/** Opens a pull request that isn't in the home page list, by URL or `owner/repo#123`. */
export function OpenPullDialog({ open, onClose }: OpenPullDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function submit(event: FormEvent) {
    event.preventDefault()
    const match = PR_URL.exec(url) ?? PR_SHORT.exec(url.trim())
    if (!match) {
      setError("Paste a GitHub pull request URL or owner/repo#123")
      return
    }
    onClose()
    navigate(`/${match[1]}/${match[2]}/pull/${match[3]}`)
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && onClose()}
      className="m-auto w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-0 text-inherit backdrop:bg-black/40 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <form onSubmit={submit} className="p-5">
        <h2 className="font-semibold">Open a pull request</h2>
        <p className="mt-1 text-sm text-neutral-500">For pull requests that aren't in your list.</p>
        <input
          autoFocus
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setError(null)
          }}
          placeholder="https://github.com/owner/repo/pull/123 or owner/repo#123"
          className={`${inputClass} mt-4 w-full`}
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" className={buttonClass}>
            Open
          </button>
        </div>
      </form>
    </dialog>
  )
}
