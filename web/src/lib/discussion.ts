// The pull request's discussion on GitHub: loading it, writing to it, and
// placing review threads in the diff.

import type { SelectedLineRange } from "@pierre/diffs"
import { useCallback, useEffect, useState } from "react"
import { api, type ApiResult } from "@/lib/api"
import type { Discussion, LineSide, ReviewThread } from "@/lib/types"

export type DiscussionState = {
  discussion: Discussion | null
  error: string | null
  reload: () => Promise<void>
  /** Runs a write, then reloads. Resolves to the error message, if any. */
  write: (request: () => Promise<ApiResult<unknown>>) => Promise<string | null>
}

/** Loads the discussion, and again whenever the tab regains focus. */
export function useDiscussion(owner: string, repo: string, number: number): DiscussionState {
  const [discussion, setDiscussion] = useState<Discussion | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(
    () =>
      api.discussion(owner, repo, number).then((result) => {
        if (result.ok) {
          setDiscussion(result.data)
          setError(null)
        } else setError(result.error)
      }),
    [owner, repo, number],
  )

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reload()
    }
    onVisible()
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [reload])

  const write = useCallback(
    async (request: () => Promise<ApiResult<unknown>>) => {
      const result = await request()
      await reload()
      return result.ok ? null : result.error
    },
    [reload],
  )

  return { discussion, error, reload, write }
}

/** Where threads on a file's current diff go (outdated ones have no line): their last line. */
export function threadPlacements(threads: ReviewThread[], path: string) {
  return threads
    .filter((t) => t.path === path && t.line != null)
    .map((thread) => ({
      side: thread.diff_side === "LEFT" ? ("deletions" as const) : ("additions" as const),
      lineNumber: thread.line!,
      thread,
    }))
}

export function threadLocation(thread: ReviewThread): string {
  const line = thread.line ?? thread.original_line
  const start = thread.start_line
  return line == null ? thread.path : `${thread.path}:${start && start !== line ? `${start}-${line}` : line}`
}

/** A gutter selection as a line range on one side; dragging upwards gives start > end. */
export function lineRange(range: SelectedLineRange): { side: LineSide; start_line: number; end_line: number } {
  const [start, end] = range.start <= range.end ? [range.start, range.end] : [range.end, range.start]
  return { side: range.side === "deletions" ? "old" : "new", start_line: start, end_line: end }
}

export const isoTimeAgoSeconds = (iso: string) => Date.parse(iso) / 1000
