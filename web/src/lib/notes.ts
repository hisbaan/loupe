// Agent notes: private comments for your coding agent, what you decided about a
// review's findings, where each comment goes (GitHub or your agent), and the
// markdown handed to the agent.

import { useCallback, useEffect, useState } from "react"
import { api, type ApiResult } from "@/lib/api"
import { threadLocation } from "@/lib/discussion"
import type {
  AgentNote,
  AnalyzedFile,
  Finding,
  FindingDecision,
  HunkAnalysis,
  LineSide,
  NewAgentNote,
  Pull,
  ReviewThread,
} from "@/lib/types"

export type AgentNotesState = {
  notes: AgentNote[]
  decisions: Map<string, FindingDecision>
  error: string | null
  /** Each resolves to an error message, or null when done. */
  add: (note: NewAgentNote) => Promise<string | null>
  update: (id: number, change: { body?: string; resolved?: boolean }) => Promise<string | null>
  remove: (id: number) => Promise<string | null>
  decide: (findingKey: string, decision: FindingDecision | null) => Promise<string | null>
  handOff: (headSha: string) => Promise<string | null>
}

export function useAgentNotes(owner: string, repo: string, number: number): AgentNotesState {
  const [notes, setNotes] = useState<AgentNote[]>([])
  const [decisions, setDecisions] = useState(new Map<string, FindingDecision>())
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(
    () =>
      api.notes(owner, repo, number).then((result) => {
        if (result.ok) {
          setNotes(result.data.notes)
          setDecisions(new Map(result.data.decisions.map((d) => [d.finding_key, d.decision])))
          setError(null)
        } else setError(result.error)
      }),
    [owner, repo, number],
  )

  useEffect(() => {
    reload()
  }, [reload])

  const run = useCallback(
    async (request: () => Promise<ApiResult<unknown>>) => {
      const result = await request()
      await reload()
      return result.ok ? null : result.error
    },
    [reload],
  )

  return {
    notes,
    decisions,
    error,
    add: (note) => run(() => api.addNote(owner, repo, number, note)),
    update: (id, change) => run(() => api.updateNote(id, change)),
    remove: (id) => run(() => api.deleteNote(id)),
    decide: (key, decision) => run(() => api.decideFinding(owner, repo, number, key, decision)),
    handOff: (headSha) => run(() => api.handOffNotes(owner, repo, number, headSha)),
  }
}

/**
 * Identifies a finding across reviews of the pull request: incremental updates
 * renumber findings but carry unchanged ones over as they were.
 */
export function findingKey(finding: Finding): string {
  return `${finding.hunk_id}:${finding.side}:${finding.start_line}-${finding.end_line}:${finding.title}`.slice(0, 500)
}

export type FindingStatus = "pending" | "agent" | "github" | "dismissed"

export function findingStatus(state: AgentNotesState, finding: Finding): FindingStatus {
  const key = findingKey(finding)
  if (state.notes.some((n) => n.finding_key === key)) return "agent"
  return state.decisions.get(key) ?? "pending"
}

/** A finding as a comment to start from: its title, body and suggested fix. */
export function findingDraft(finding: Finding): string {
  return [`**${finding.title}**`, finding.body, finding.suggestion && `Suggested fix:\n\n${finding.suggestion}`]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Whether a note's lines are in the diff on screen: its hunk is unchanged
 * (hunk ids hash the path and the hunk's text, line numbers included). A note
 * with no hunk only places on the commit it was written on.
 */
export function isPlaced(note: AgentNote, hunkIds: Set<string>, headSha: string): boolean {
  return note.hunk_id ? hunkIds.has(note.hunk_id) : note.head_sha === headSha
}

/** The hunk a line range starts in, on one side. */
export function hunkAt(file: AnalyzedFile, side: LineSide, line: number): HunkAnalysis | undefined {
  return file.analysis.hunks.find((h) => {
    const [start, count] = side === "new" ? [h.new_start, h.new_lines] : [h.old_start, h.old_lines]
    return line >= start && line < start + count
  })
}

// Where a new comment goes. Remembered per pull request in this browser, so
// you keep going the way you were.

export type Destination = "github" | "agent"

const destinationKey = (owner: string, repo: string, number: number) => `loupe:destination:${owner}/${repo}#${number}`

function readDestination(key: string): Destination | null {
  try {
    const value = localStorage.getItem(key)
    return value === "github" || value === "agent" ? value : null
  } catch {
    return null
  }
}

/** Your last choice on this pull request, else `fallback`. */
export function useDestination(owner: string, repo: string, number: number, fallback: Destination) {
  const key = destinationKey(owner, repo, number)
  const [stored, setStored] = useState(() => ({ key, value: readDestination(key) }))
  // Another pull request in the same page: read its own choice.
  const current = stored.key === key ? stored.value : readDestination(key)
  if (stored.key !== key) setStored({ key, value: current })

  const choose = useCallback(
    (value: Destination) => {
      setStored({ key, value })
      try {
        localStorage.setItem(key, value)
      } catch {
        // Not remembered; it still applies until you leave the page.
      }
    },
    [key],
  )
  return [current ?? fallback, choose] as const
}

// The markdown export.

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

/** The lines a comment covers, numbered, as the diff shows them. */
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

const shortSha = (sha: string) => sha.slice(0, 7)
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

type ExportInput = {
  owner: string
  repo: string
  pull: Pull
  files: AnalyzedFile[]
  /** Open notes. */
  notes: AgentNote[]
  /** Unresolved GitHub review threads to include. */
  threads: ReviewThread[]
}

/**
 * Markdown instructions for a coding agent, pinned to the head commit on
 * screen: your open notes, then unresolved review threads from GitHub.
 */
export function exportMarkdown({ owner, repo, pull, files, notes, threads }: ExportInput): string {
  const fileByPath = new Map(files.map((f) => [f.filename, f]))
  const hunkIds = new Set(files.flatMap((f) => f.analysis.hunks.map((h) => h.id)))
  const parts: string[] = [
    `# Review notes for ${owner}/${repo}#${pull.number}: ${pull.title}`,
    [
      `Pull request: ${pull.html_url}`,
      `These notes are for commit \`${pull.head.sha}\` (base \`${pull.base.sha}\`). Line numbers refer to that commit unless an item says otherwise.`,
      threads.length > 0
        ? "Address each item below: the reviewer's own notes first, then open review threads from GitHub. Thread comments are quoted as their authors wrote them."
        : "Address each item below.",
    ].join("\n"),
  ]

  let n = 0
  for (const note of notes) {
    const placed = isPlaced(note, hunkIds, pull.head.sha)
    const code = placed ? snippet(fileByPath.get(note.path), note.side, note.start_line, note.end_line) : note.snippet
    parts.push(
      [
        `## ${++n}. Note`,
        [
          `- **Where:** ${where(note.path, note.side, note.start_line, note.end_line)}`,
          !placed &&
            `- **Written on:** commit \`${shortSha(note.head_sha)}\`; these lines have changed since, so check whether it still applies.`,
        ]
          .filter(Boolean)
          .join("\n"),
        code && fence(code, note.path),
        note.body,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }
  for (const thread of threads) {
    const side: LineSide = thread.diff_side === "LEFT" ? "old" : "new"
    const code =
      thread.line != null
        ? snippet(fileByPath.get(thread.path), side, thread.start_line ?? thread.line, thread.line)
        : null
    const comments = thread.comments.nodes.map((c) => `**@${c.author?.login ?? "ghost"}:**\n\n${quote(c.body)}`)
    if (thread.comments.total_count > thread.comments.nodes.length) {
      comments.push(`_${thread.comments.total_count - thread.comments.nodes.length} more comments on GitHub._`)
    }
    parts.push(
      [
        `## ${++n}. Review thread on GitHub`,
        `- **Where:** \`${threadLocation(thread)}\`${thread.is_outdated ? " (outdated: the lines changed after this comment)" : ""}`,
        code && fence(code, thread.path),
        ...comments,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }
  if (n === 0) parts.push("_Nothing to address._")
  return parts.join("\n\n") + "\n"
}
