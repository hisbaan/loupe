import { useEffect, useState } from "react"
import { linkButtonClass } from "@/components/ui"
import { renderMermaid, type RenderedDiagram } from "@/lib/mermaid"

type MermaidDiagramProps = {
  source: string
  caption: string | null
  title: string
}

type Result = { kind: "ok"; diagram: RenderedDiagram } | { kind: "error"; message: string }
type State = { kind: "loading" } | Result

export function MermaidDiagram({ source, caption, title }: MermaidDiagramProps) {
  // Keyed by source, so a new source shows as loading until it's drawn.
  const [rendered, setRendered] = useState<{ source: string; result: Result } | null>(null)
  const [showSource, setShowSource] = useState(false)
  const state: State = rendered?.source === source ? rendered.result : { kind: "loading" }

  useEffect(() => {
    let cancelled = false
    const done = (result: Result) => !cancelled && setRendered({ source, result })
    renderMermaid(source).then(
      (diagram) => done({ kind: "ok", diagram }),
      (err) => done({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      cancelled = true
    }
  }, [source])

  return (
    <figure className="flex flex-col gap-2">
      {state.kind === "loading" && <p className="text-sm text-neutral-500">Drawing diagram…</p>}
      {state.kind === "ok" && (
        <div className="overflow-x-auto">
          <img
            src={state.diagram.url}
            width={state.diagram.width}
            height={state.diagram.height}
            alt={caption ?? title}
            className="h-auto max-w-full"
          />
        </div>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-amber-600">Couldn't draw this diagram ({state.message.split("\n")[0]}).</p>
      )}
      <figcaption className="flex items-baseline gap-3 text-xs text-neutral-500">
        {caption && <span className="flex-1">{caption}</span>}
        {state.kind !== "error" && (
          <button type="button" onClick={() => setShowSource((s) => !s)} className={linkButtonClass}>
            {showSource ? "Hide source" : "Source"}
          </button>
        )}
      </figcaption>
      {(showSource || state.kind === "error") && (
        <pre className="overflow-x-auto rounded-md bg-neutral-100 p-3 text-xs dark:bg-neutral-900">{source}</pre>
      )}
    </figure>
  )
}
