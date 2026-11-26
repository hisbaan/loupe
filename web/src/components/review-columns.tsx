import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { SidebarNavigateContext } from "@/lib/sidebar"
import { cn } from "@/lib/utils"

/** Below this the sidebar starts collapsed and opens over the diff instead of beside it. */
const WIDE_QUERY = "(min-width: 1024px)"

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

const isWide = () => window.matchMedia(WIDE_QUERY).matches

/** Your choice on a wide screen, kept while you switch tabs. */
let wideOpen = true

/** The pull page body: a collapsible sticky sidebar and the diff column. */
export function ReviewColumns({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  const wide = useSyncExternalStore(subscribeWide, isWide)
  const [narrowOpen, setNarrowOpen] = useState(false)
  const [wasWide, setWasWide] = useState(wide)
  const [openWide, setOpenWide] = useState(wideOpen)
  const open = wide ? openWide : narrowOpen
  const overlay = !wide && open
  const ref = useRef<HTMLElement>(null)

  function setOpen(next: boolean) {
    if (wide) {
      wideOpen = next
      setOpenWide(next)
    } else setNarrowOpen(next)
  }

  // Collapsed again whenever the screen gets narrow.
  if (wide !== wasWide) {
    setWasWide(wide)
    setNarrowOpen(false)
  }

  // Over the diff, close on a click outside or Escape.
  useEffect(() => {
    if (!overlay) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setNarrowOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNarrowOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [overlay])

  const toggle = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
      title={open ? "Collapse sidebar" : "Expand sidebar"}
      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-neutral-300 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
    >
      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
        <path d="M6 2.75v10.5" />
        <path d={open ? "M10.5 6.5 9 8l1.5 1.5" : "M9 6.5 10.5 8 9 9.5"} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )

  return (
    <div className="flex gap-6">
      {/* In flow whenever the sidebar isn't, so opening it over the diff doesn't move the diff. */}
      {!(open && wide) && <div className="sticky top-4 h-fit shrink-0">{toggle}</div>}
      {open && (
        <aside
          ref={ref}
          className={cn(
            "flex w-72 shrink-0 flex-col gap-4 overflow-y-auto",
            overlay
              ? "fixed inset-y-0 left-0 z-30 max-w-[85vw] border-r border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
              : "sticky top-4 h-fit max-h-[calc(100vh-2rem)]",
          )}
        >
          <div className="flex justify-end">{toggle}</div>
          <SidebarNavigateContext.Provider value={() => overlay && setNarrowOpen(false)}>{aside}</SidebarNavigateContext.Provider>
        </aside>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
