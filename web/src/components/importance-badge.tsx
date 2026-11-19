import { cn } from "@/lib/utils"
import type { Importance } from "@/lib/types"

const STYLES: Record<Importance, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  normal: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  low: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
}

type ImportanceBadgeProps = {
  importance: Importance
  className?: string
}

export function ImportanceBadge({ importance, className }: ImportanceBadgeProps) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", STYLES[importance], className)}>{importance}</span>
  )
}
