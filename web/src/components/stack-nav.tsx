import { useEffect, useState } from "react"
import { Link } from "@/components/link"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Stack, StackLayer } from "@/lib/types"

type StackNavProps = {
  owner: string
  repo: string
  number: number
}

const STATE_CLASSES: Record<StackLayer["state"], string> = {
  open: "",
  merged: "text-purple-700 dark:text-purple-400",
  closed: "text-neutral-500 line-through",
}

/**
 * The stack this pull request is a layer of, bottom first. Each layer's diff
 * is only that layer, so reviewing a stack means stepping through it.
 */
export function StackNav({ owner, repo, number }: StackNavProps) {
  const [stack, setStack] = useState<Stack | null>(null)

  useEffect(() => {
    let cancelled = false
    api.stack(owner, repo, number).then((r) => {
      if (!cancelled && r.ok) setStack(r.data.stack)
    })
    return () => {
      cancelled = true
    }
  }, [owner, repo, number])

  const index = stack?.layers.findIndex((l) => l.number === number) ?? -1
  if (!stack || index < 0) return null
  const layerHref = (layer: StackLayer) => `/${owner}/${repo}/pull/${layer.number}`
  const below = stack.layers[index - 1]
  const above = stack.layers[index + 1]

  return (
    <nav className="mt-4 rounded-md border border-neutral-200 text-sm dark:border-neutral-800">
      <div className="flex items-center gap-3 border-b border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
        <span className="flex-1">
          {stack.number != null ? `Stack #${stack.number}` : "Stacked on other pull requests"} · layer {index + 1} of{" "}
          {stack.layers.length} · onto {stack.base}
        </span>
        {below && (
          <Link href={layerHref(below)} className="hover:text-neutral-900 dark:hover:text-neutral-100">
            ↓ #{below.number}
          </Link>
        )}
        {above && (
          <Link href={layerHref(above)} className="hover:text-neutral-900 dark:hover:text-neutral-100">
            ↑ #{above.number}
          </Link>
        )}
      </div>
      {/* Top of the stack first, as GitHub shows it. */}
      <ol className="flex flex-col-reverse py-1">
        {stack.layers.map((layer, i) => (
          <li key={layer.number}>
            <Link
              href={layerHref(layer)}
              aria-current={layer.number === number ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 px-3 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900",
                layer.number === number && "bg-neutral-100 font-medium dark:bg-neutral-900",
              )}
            >
              <span className="w-5 shrink-0 text-right text-xs text-neutral-500">{i + 1}</span>
              <span className={cn("truncate", STATE_CLASSES[layer.state])}>{layer.title || `#${layer.number}`}</span>
              <span className="shrink-0 text-xs text-neutral-500">
                #{layer.number}
                {layer.draft && " · draft"}
                {layer.state !== "open" && ` · ${layer.state}`}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}
