import type { Credential, Me, PullResponse, ReviewProgress, ReviewRecord } from "@/lib/types"

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string }

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init })
    if (res.ok) return { ok: true, status: res.status, data: (await res.json()) as T }
    return { ok: false, status: res.status, error: await errorMessage(res) }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Network error" }
  }
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? res.statusText
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

function pullPath(owner: string, repo: string, number: number) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`
}

/** Reads a server-sent event stream, calling `onEvent` with each event's data. */
async function readEvents(res: Response, onEvent: (data: string) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value.replace(/\r/g, "")
    let end: number
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data) onEvent(data)
    }
  }
}

export const api = {
  me: () => request<Me>("/me"),
  pull: (owner: string, repo: string, number: number) => request<PullResponse>(pullPath(owner, repo, number)),
  reviews: (owner: string, repo: string, number: number) =>
    request<{ reviews: ReviewRecord[] }>(`${pullPath(owner, repo, number)}/reviews`),
  models: (credential: Credential) => request<{ models: string[] }>("/inference/models", postJson({ credential })),

  /** Starts a review and reports progress until it finishes or fails. */
  async generateReview(
    owner: string,
    repo: string,
    number: number,
    body: { credential: Credential; model: string },
    onProgress: (progress: ReviewProgress) => void,
  ) {
    try {
      const res = await fetch(`/api${pullPath(owner, repo, number)}/reviews`, {
        credentials: "same-origin",
        ...postJson(body),
      })
      if (!res.ok) {
        onProgress({ type: "error", message: await errorMessage(res) })
        return
      }
      let finished = false
      await readEvents(res, (data) => {
        const progress = JSON.parse(data) as ReviewProgress
        finished ||= progress.type === "done" || progress.type === "error"
        onProgress(progress)
      })
      if (!finished) onProgress({ type: "error", message: "The connection closed before the review finished" })
    } catch (err) {
      onProgress({ type: "error", message: err instanceof Error ? err.message : "Network error" })
    }
  },
}
