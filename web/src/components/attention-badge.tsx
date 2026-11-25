import { cn } from "@/lib/utils"
import type { Attention } from "@/lib/types"

const LABELS: Record<Attention, string> = { review_closely: "Review closely", read: "Read", skim: "Skim" }

const STYLES: Record<Attention, string> = {
  review_closely: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  read: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  skim: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
}

/** How carefully a section deserves reading. */
export function AttentionBadge({ attention, className }: { attention: Attention; className?: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", STYLES[attention], className)}>
      {LABELS[attention]}
    </span>
  )
}
