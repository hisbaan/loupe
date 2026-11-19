// Renders model-written mermaid diagrams. The source is untrusted (it comes
// from a model that read the pull request), so:
// - mermaid runs with securityLevel "strict" and plain SVG text labels;
// - `secure` stops `%%{init}%%` directives in the source loosening that;
// - the SVG is shown through an <img>, never inserted into the page. An SVG
//   loaded as an image can't run scripts or fetch anything, so even a mermaid
//   sanitiser bug can't reach the page.
// mermaid is large, so it's only loaded when a review has a diagram.

import type { Mermaid } from "mermaid"

const MAX_SOURCE = 8_000

let loaded: Promise<Mermaid> | null = null
let theme: "default" | "dark" | null = null
let counter = 0
// mermaid keeps global state while rendering, so render one at a time.
let queue: Promise<unknown> = Promise.resolve()

function load(): Promise<Mermaid> {
  loaded ??= import("mermaid").then((m) => m.default)
  return loaded
}

function configure(mermaid: Mermaid) {
  const wanted = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default"
  if (theme === wanted) return
  theme = wanted
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MAX_SOURCE,
    maxEdges: 200,
    theme: wanted,
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
      "themeCSS",
      "fontFamily",
    ],
  })
}

export type RenderedDiagram = {
  /** A data: URL for an <img>. */
  url: string
  width: number
  height: number
}

async function renderNow(source: string): Promise<RenderedDiagram> {
  if (source.length > MAX_SOURCE) throw new Error("Diagram is too large")
  const mermaid = await load()
  configure(mermaid)
  const { svg } = await mermaid.render(`loupe-mermaid-${++counter}`, source)
  const [, , width, height] = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 600 400").split(/\s+/).map(Number)
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height }
}

export function renderMermaid(source: string): Promise<RenderedDiagram> {
  const result = queue.then(() => renderNow(source))
  queue = result.catch(() => undefined)
  return result
}
