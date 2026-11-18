import type { PullFile } from "@/lib/types"

/**
 * GitHub's per-file `patch` is just the hunks. Add the unified-diff file
 * headers so @pierre/diffs can tell which file (and language) it is.
 */
export function toUnifiedPatch(file: PullFile): string | null {
  if (file.patch == null) return null
  const oldName = file.status === "added" ? "/dev/null" : `a/${file.previous_filename ?? file.filename}`
  const newName = file.status === "removed" ? "/dev/null" : `b/${file.filename}`
  const body = file.patch.endsWith("\n") ? file.patch : `${file.patch}\n`
  return `--- ${oldName}\n+++ ${newName}\n${body}`
}
