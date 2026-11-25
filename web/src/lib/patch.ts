import type { AnalyzedFile, HunkAnalysis, HunkKind, PullFile } from "@/lib/types"

/** Splits GitHub's per-file patch into hunks, the same way api/src/prepass does. */
export function splitHunks(patch: string): string[] {
  const hunks: string[] = []
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith("@@ ")) hunks.push(line)
    else if (hunks.length > 0) hunks[hunks.length - 1] += line
  }
  return hunks
}

function headerOf(hunk: string): string {
  return hunk.split("\n", 1)[0].replace(/\r$/, "")
}

/**
 * GitHub's per-file `patch` is just the hunks. Add git's file headers so
 * @pierre/diffs can tell which file (and language) it is and whether it was
 * added, removed or renamed. Without the `diff --git` line it keeps the `a/`
 * and `b/` prefixes and shows every file as a rename. `hunks` defaults to all
 * of them.
 */
export function toUnifiedPatch(file: PullFile, hunks?: string[]): string | null {
  if (file.patch == null) return null
  const oldPath = file.previous_filename ?? file.filename
  const header = [`diff --git a/${oldPath} b/${file.filename}`]
  if (file.status === "added") header.push("new file mode 100644")
  if (file.status === "removed") header.push("deleted file mode 100644")
  if (file.status === "renamed" && oldPath !== file.filename) {
    // The parser only marks a rename when it sees a similarity line; GitHub doesn't give the percentage.
    header.push("similarity index", `rename from ${oldPath}`, `rename to ${file.filename}`)
  }
  header.push(
    `--- ${file.status === "added" ? "/dev/null" : `a/${oldPath}`}`,
    `+++ ${file.status === "removed" ? "/dev/null" : `b/${file.filename}`}`,
  )
  const body = (hunks ?? [file.patch]).map((h) => (h.endsWith("\n") ? h : `${h}\n`)).join("")
  return `${header.join("\n")}\n${body}`
}

/** The patch's hunks, or null if the client splits them differently from the server's analysis. */
export function alignedHunks(file: AnalyzedFile): string[] | null {
  if (file.patch == null) return null
  const hunks = splitHunks(file.patch)
  const analysis = file.analysis.hunks
  const aligned = hunks.length === analysis.length && hunks.every((h, i) => headerOf(h) === analysis[i].header)
  return aligned ? hunks : null
}

/** A file, or some of its hunks, shown as one card. */
export type FileSlice = {
  file: AnalyzedFile
  /** The hunks shown, in file order; null for the whole file. */
  hunkIds: string[] | null
}

/** The patch for a slice, or null if the file has no textual diff. */
export function slicePatch({ file, hunkIds }: FileSlice): string | null {
  if (hunkIds == null) return toUnifiedPatch(file)
  const texts = alignedHunks(file)
  if (texts == null) return toUnifiedPatch(file)
  const wanted = new Set(hunkIds)
  return toUnifiedPatch(file, texts.filter((_, i) => wanted.has(file.analysis.hunks[i].id)))
}

/** The hunks a slice shows. */
export function sliceHunks({ file, hunkIds }: FileSlice): HunkAnalysis[] {
  if (hunkIds == null) return file.analysis.hunks
  const wanted = new Set(hunkIds)
  return file.analysis.hunks.filter((h) => wanted.has(h.id))
}

export type CollapsedGroup = { kind: HunkKind; slices: FileSlice[] }

/**
 * Splits files into what to review and what the pre-pass collapsed, by kind.
 * If the client can't match a file's hunks to the analysis, the whole file
 * stays in review rather than guess which part to hide.
 */
export function splitCollapsed(files: AnalyzedFile[]): { review: FileSlice[]; collapsed: CollapsedGroup[] } {
  const review: FileSlice[] = []
  const byKind = new Map<HunkKind, FileSlice[]>()
  const collapse = (kind: HunkKind, slice: FileSlice) => byKind.set(kind, [...(byKind.get(kind) ?? []), slice])

  for (const file of files) {
    const { analysis } = file
    if (analysis.collapsible) {
      collapse(analysis.kind ?? analysis.hunks[0]?.kind ?? "rename", { file, hunkIds: null })
      continue
    }
    const hidden = analysis.hunks.filter((h) => h.collapsible)
    if (hidden.length === 0 || alignedHunks(file) == null) {
      review.push({ file, hunkIds: null })
      continue
    }
    review.push({ file, hunkIds: analysis.hunks.filter((h) => !h.collapsible).map((h) => h.id) })
    for (const kind of new Set(hidden.map((h) => h.kind))) {
      collapse(kind, { file, hunkIds: hidden.filter((h) => h.kind === kind).map((h) => h.id) })
    }
  }
  const collapsed = [...byKind].map(([kind, slices]) => ({ kind, slices }))
  return { review, collapsed }
}

export const KIND_LABELS: Record<HunkKind, string> = {
  code: "code",
  import_only: "imports",
  lockfile: "lockfile",
  generated: "generated",
  vendored: "vendored",
  rename: "rename",
  whitespace_only: "whitespace",
  docs: "docs",
  test: "tests",
  config: "config",
}
