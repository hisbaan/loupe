import type { AnalyzedFile, HunkKind, PullFile } from "@/lib/types"

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

export type CollapsePlan = {
  /** Patch with collapsible hunks removed, or null when nothing is hidden. */
  reducedPatch: string | null
  hiddenKinds: HunkKind[]
  hiddenCount: number
}

/**
 * Works out which hunks to hide. If the client's hunk split disagrees with
 * the server's analysis, hides nothing rather than guess.
 */
export function planCollapse(file: AnalyzedFile): CollapsePlan {
  const none: CollapsePlan = { reducedPatch: null, hiddenKinds: [], hiddenCount: 0 }
  if (file.patch == null) return none

  const hunks = splitHunks(file.patch)
  const analysis = file.analysis.hunks
  const aligned = hunks.length === analysis.length && hunks.every((h, i) => headerOf(h) === analysis[i].header)
  if (!aligned) return none

  const kept = hunks.filter((_, i) => !analysis[i].collapsible)
  const hidden = analysis.filter((h) => h.collapsible)
  if (hidden.length === 0 || kept.length === 0) return none

  return {
    reducedPatch: toUnifiedPatch(file, kept),
    hiddenKinds: [...new Set(hidden.map((h) => h.kind))],
    hiddenCount: hidden.length,
  }
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
