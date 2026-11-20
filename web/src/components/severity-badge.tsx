import { cn } from "@/lib/utils"
import type { Severity } from "@/lib/types"

const STYLES: Record<Severity, string> = {
  blocker: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  major: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  minor: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  nit: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", STYLES[severity], className)}>{severity}</span>
}
