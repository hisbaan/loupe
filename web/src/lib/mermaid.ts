// Renders model-written mermaid diagrams with pele. The source is untrusted
// (it comes from a model that read the pull request), so:
// - only flowcharts and sequence diagrams are drawn (the only modules loaded);
// - pele escapes label text and drops links and images, so `click` and
//   `%%{init}%%` can't add anything active;
// - the SVG is shown through an <img>, never inserted into the page. An SVG
//   loaded as an image can't run scripts or fetch anything, so even a pele
//   escaping bug can't reach the page.
// pele is only loaded when a review has a diagram.

type Pele = typeof import("pele/core")

const MAX_SOURCE = 8_000
const MAX_EDGES = 200
const MAX_OUTPUT = 2_000_000

// The SVG reads its colours from --pele-* variables with light fallbacks.
// An <img> can't see the page's CSS, so dark values go on the root element.
const DARK = [
  "--pele-bg:#171717",
  "--pele-fg:#e5e5e5",
  "--pele-muted:#a3a3a3",
  "--pele-line:#d4d4d4",
  "--pele-surface:#262626",
  "--pele-surface-alt:#404040",
  "--pele-border:#737373",
  "--pele-accent:#60a5fa",
].join(";")

let loaded: Promise<Pele> | null = null

function load(): Promise<Pele> {
  loaded ??= Promise.all([
    import("pele/core"),
    import("pele/diagrams/flowchart"),
    import("pele/diagrams/sequence"),
  ]).then(([pele, flowchart, sequence]) => {
    pele.register(flowchart.default, sequence.default)
    return pele
  })
  return loaded
}

export type RenderedDiagram = {
  /** A data: URL for an <img>. */
  url: string
  width: number
  height: number
}

export async function renderMermaid(source: string): Promise<RenderedDiagram> {
  if (source.length > MAX_SOURCE) throw new Error("Diagram is too large")
  const pele = await load()
  const type = pele.detectType(source)
  if (type !== "flowchart" && type !== "sequence") throw new Error("Only flowcharts and sequence diagrams are drawn")
  const rendered = pele.render(source, {
    links: false,
    images: false,
    autoDirection: false,
    limit: MAX_SOURCE,
    maxEdges: MAX_EDGES,
    outputLimit: MAX_OUTPUT,
  })
  const { width, height } = rendered
  const svg = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? rendered.svg.replace(/^<svg\b([^>]*?) style="/, `<svg$1 style="${DARK};`)
    : rendered.svg
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height }
}
