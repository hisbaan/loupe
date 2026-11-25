// Self-review helpers: decisions on findings, line snippets from the patch,
// and the markdown export handed to a coding agent.

import { bySeverity } from "@/lib/reviews"
import type { AnalyzedFile, Finding, LineSide, Pull, ReviewComment, SelfReviewNotes, SelfReviewRecord } from "@/lib/types"

export type FindingStatus = "pending" | "accepted" | "dismissed"

export function findingStatus(notes: SelfReviewNotes, id: string): FindingStatus {
  return notes.findings?.[id]?.status ?? "pending"
}

/** The finding's body, as edited by the user if they did. */
export function findingBody(notes: SelfReviewNotes, finding: Finding): string {
  return notes.findings?.[finding.id]?.body ?? finding.body
}

export function setFinding(
  notes: SelfReviewNotes,
  id: string,
  decision: { status: "accepted" | "dismissed"; body?: string } | null,
): SelfReviewNotes {
  const findings = { ...notes.findings }
  if (decision) findings[id] = decision
  else delete findings[id]
  return { ...notes, findings }
}

export function upsertComment(notes: SelfReviewNotes, comment: ReviewComment): SelfReviewNotes {
  const comments = (notes.comments ?? []).filter((c) => c.id !== comment.id)
  return { ...notes, comments: [...comments, comment] }
}

export function removeComment(notes: SelfReviewNotes, id: string): SelfReviewNotes {
  return { ...notes, comments: (notes.comments ?? []).filter((c) => c.id !== id) }
}

/** `{ "new" | "old" }` line → text for the lines a file's patch shows. */
function patchLines(file: AnalyzedFile, side: LineSide): Map<number, string> {
  const lines = new Map<number, string>()
  let old = 0
  let next = 0
  for (const line of (file.patch ?? "").split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      old = Number(header[1])
      next = Number(header[2])
      continue
    }
    const marker = line[0]
    const text = line.slice(1)
    if (marker === " ") {
      lines.set(side === "new" ? next : old, text)
      old++
      next++
    } else if (marker === "+") {
      if (side === "new") lines.set(next, text)
      next++
    } else if (marker === "-") {
      if (side === "old") lines.set(old, text)
      old++
    }
  }
  return lines
}

/** The lines a finding or comment covers, numbered, as the diff shows them. */
export function snippet(file: AnalyzedFile | undefined, side: LineSide, start: number, end: number): string | null {
  if (!file) return null
  const lines = patchLines(file, side)
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const text = lines.get(n)
    if (text !== undefined) out.push(`${String(n).padStart(4)} | ${text}`)
  }
  return out.length > 0 ? out.join("\n") : null
}

const LANGUAGES: Record<string, string> = {
  rs: "rust", ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", py: "python", go: "go", java: "java",
  kt: "kotlin", swift: "swift", rb: "ruby", php: "php", cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  sql: "sql", sh: "sh", bash: "sh", yml: "yaml", yaml: "yaml", json: "json", toml: "toml", md: "markdown",
  css: "css", html: "html", vue: "vue", svelte: "svelte", ex: "elixir", exs: "elixir", hs: "haskell", dart: "dart",
}

function fence(code: string, path: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = "`".repeat(Math.max(3, longestRun + 1))
  const language = LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? ""
  return `${ticks}${language}\n${code}\n${ticks}`
}

function where(path: string, side: LineSide, start: number, end: number): string {
  const lines = start === end ? `line ${start}` : `lines ${start}-${end}`
  return `\`${path}\` ${lines}${side === "old" ? " (base commit; removed by this change)" : ""}`
}

type ExportInput = {
  owner: string
  repo: string
  pull: Pull
  record: SelfReviewRecord
  notes: SelfReviewNotes
  files: AnalyzedFile[]
}

/** Items that go into an export: your comments, then findings you didn't dismiss. */
export function exportItems(record: SelfReviewRecord, notes: SelfReviewNotes) {
  const findings = record.review.findings
    .filter((f) => findingStatus(notes, f.id) !== "dismissed")
    .sort(bySeverity)
  return { comments: notes.comments ?? [], findings }
}

/**
 * Markdown instructions for a coding agent, pinned to the reviewed commit.
 * Snippets come from the diff on screen, so they're left out when the
 * self-review is of an earlier commit.
 */
export function exportMarkdown({ owner, repo, pull, record, notes, files }: ExportInput): string {
  const fileByPath = new Map(files.map((f) => [f.filename, f]))
  const { comments, findings } = exportItems(record, notes)
  const code = (path: string, side: LineSide, start: number, end: number) => {
    const text = record.current ? snippet(fileByPath.get(path), side, start, end) : null
    return text ? fence(text, path) : null
  }

  const parts: string[] = [
    `# Review notes for ${owner}/${repo}#${pull.number}: ${pull.title}`,
    [
      `Pull request: ${pull.html_url}`,
      `These notes apply to commit \`${record.head_sha}\` (base \`${record.base_sha}\`). Line numbers refer to that commit unless marked as the base commit.`,
      "Address each item below. Reviewer comments come first, then findings by severity.",
    ].join("\n"),
  ]

  let n = 0
  for (const c of comments) {
    parts.push(
      [`## ${++n}. Reviewer comment`, `- **Where:** ${where(c.path, c.side, c.start_line, c.end_line)}`, code(c.path, c.side, c.start_line, c.end_line), c.body]
        .filter(Boolean)
        .join("\n\n"),
    )
  }
  for (const f of findings) {
    parts.push(
      [
        `## ${++n}. ${f.title}`,
        `- **Where:** ${where(f.path, f.side, f.start_line, f.end_line)}\n- **Severity:** ${f.severity} (${f.category})`,
        code(f.path, f.side, f.start_line, f.end_line),
        findingBody(notes, f),
        f.suggestion && `**Suggested fix:**\n\n${f.suggestion}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }
  if (n === 0) parts.push("_Nothing to address._")
  return parts.join("\n\n") + "\n"
}
