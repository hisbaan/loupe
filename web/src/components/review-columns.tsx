import type { ReactNode } from "react"

/** The pull page body: a sticky sidebar and the diff column. */
export function ReviewColumns({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-6">
      <aside className="sticky top-4 flex h-fit max-h-[calc(100vh-2rem)] w-72 shrink-0 flex-col gap-4 overflow-y-auto">
        {aside}
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
