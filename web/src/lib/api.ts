import type {
  AgentNote,
  AgentNoteList,
  ChatGptTokens,
  ClientConfig,
  Credential,
  Discussion,
  FindingDecision,
  JobProgress,
  JobRequest,
  LineCommentRequest,
  Me,
  NewAgentNote,
  NewVaultKey,
  PullResponse,
  PullListResponse,
  ReviewRecord,
  Stack,
  ReviewEvent,
  TrustedReviewer,
  VaultKeyRecord,
  VaultRecord,
} from "@/lib/types"

/** Conversation comments, or comments in review threads. */
export type CommentKind = "issue-comments" | "review-comments"

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string }

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init })
    if (res.status === 204) return { ok: true, status: res.status, data: undefined as T }
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

function sendJson(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

function postJson(body: unknown): RequestInit {
  return sendJson("POST", body)
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
  config: () => request<ClientConfig>("/config"),
  setupManifest: (body: { token: string; name: string; organization: string | null; public: boolean }) =>
    request<{ action: string; manifest: string }>("/setup/manifest", postJson(body)),
  setupConvert: (body: { token: string; code: string; state: string }) =>
    request<{ env: string; app_url: string; install_url: string }>("/setup/convert", postJson(body)),
  me: () => request<Me>("/me"),
  /** Owned by `@/lib/settings`, which validates it; `{}` until first saved. */
  settings: () => request<Record<string, unknown>>("/settings"),
  saveSettings: (settings: unknown) => request<void>("/settings", sendJson("PUT", settings)),
  pulls: (refresh = false) => request<PullListResponse>(refresh ? "/pulls?refresh=true" : "/pulls"),
  pull: (owner: string, repo: string, number: number) => request<PullResponse>(pullPath(owner, repo, number)),
  stack: (owner: string, repo: string, number: number) =>
    request<{ stack: Stack | null }>(`${pullPath(owner, repo, number)}/stack`),

  discussion: (owner: string, repo: string, number: number) =>
    request<Discussion>(`${pullPath(owner, repo, number)}/discussion`),
  addComment: (owner: string, repo: string, number: number, body: string) =>
    request<void>(`${pullPath(owner, repo, number)}/comments`, postJson({ body })),
  addLineComment: (owner: string, repo: string, number: number, comment: LineCommentRequest) =>
    request<void>(`${pullPath(owner, repo, number)}/line-comments`, postJson(comment)),
  /** Submits your review with any pending comments; 409 means new commits were pushed. */
  submitReview: (owner: string, repo: string, number: number, body: { head_sha: string; event: ReviewEvent; body: string }) =>
    request<void>(`${pullPath(owner, repo, number)}/review`, postJson(body)),
  discardReview: (owner: string, repo: string, number: number) =>
    request<void>(`${pullPath(owner, repo, number)}/review`, { method: "DELETE" }),
  /** Takes a draft out of draft; 409 means new commits were pushed. */
  markReady: (owner: string, repo: string, number: number, headSha: string) =>
    request<void>(`${pullPath(owner, repo, number)}/ready`, postJson({ head_sha: headSha })),
  reply: (threadId: string, body: string) =>
    request<void>(`/discussion/threads/${encodeURIComponent(threadId)}/replies`, postJson({ body })),
  setResolved: (threadId: string, resolved: boolean) =>
    request<void>(`/discussion/threads/${encodeURIComponent(threadId)}/resolved`, sendJson("PUT", { resolved })),
  editComment: (kind: CommentKind, id: string, body: string) =>
    request<void>(`/discussion/${kind}/${encodeURIComponent(id)}`, sendJson("PATCH", { body })),
  deleteComment: (kind: CommentKind, id: string) =>
    request<void>(`/discussion/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reviews: (owner: string, repo: string, number: number) =>
    request<{ reviews: ReviewRecord[] }>(`${pullPath(owner, repo, number)}/reviews`),
  models: (credential: Credential) => request<{ models: string[] }>("/inference/models", postJson({ credential })),
  /** Relayed through the server; 410 means the user has to sign in again. */
  refreshChatgpt: (body: { client_id: string; refresh_token: string }) =>
    request<ChatGptTokens>("/inference/chatgpt/refresh", postJson(body)),

  vault: () => request<{ vault: VaultRecord | null }>("/vault"),
  createVault: (body: { ciphertext: string; key: NewVaultKey }) =>
    request<{ vault: VaultRecord }>("/vault", postJson(body)),
  /** Compare-and-swap on `version`; 409 means someone else wrote first. */
  updateVault: (body: { version: number; ciphertext: string }) =>
    request<{ version: number }>("/vault", sendJson("PUT", body)),
  trusted: () => request<{ trusted: TrustedReviewer[] }>("/trusted"),
  trust: (login: string, autoLoad: boolean) =>
    request<TrustedReviewer>(`/trusted/${encodeURIComponent(login)}`, sendJson("PUT", { auto_load: autoLoad })),
  untrust: (login: string) => request<void>(`/trusted/${encodeURIComponent(login)}`, { method: "DELETE" }),

  deleteVault: () => request<void>("/vault", { method: "DELETE" }),
  addVaultKey: (key: NewVaultKey) => request<VaultKeyRecord>("/vault/keys", postJson(key)),
  removeVaultKey: (id: number) => request<void>(`/vault/keys/${id}`, { method: "DELETE" }),

  /** Starts a review and reports progress until it finishes or fails. */
  generateReview: (
    owner: string,
    repo: string,
    number: number,
    body: JobRequest & { based_on?: number },
    onProgress: (progress: JobProgress<ReviewRecord>) => void,
  ) => runJob(`${pullPath(owner, repo, number)}/reviews`, body, onProgress),

  /** Your agent notes on a pull request, and what you decided about its findings. */
  notes: (owner: string, repo: string, number: number) =>
    request<AgentNoteList>(`${pullPath(owner, repo, number)}/notes`),
  addNote: (owner: string, repo: string, number: number, note: NewAgentNote) =>
    request<AgentNote>(`${pullPath(owner, repo, number)}/notes`, postJson(note)),
  updateNote: (id: number, change: { body?: string; resolved?: boolean }) =>
    request<AgentNote>(`/notes/${id}`, sendJson("PATCH", change)),
  deleteNote: (id: number) => request<void>(`/notes/${id}`, { method: "DELETE" }),
  /** Marks your open notes as handed to your agent at this commit. */
  handOffNotes: (owner: string, repo: string, number: number, headSha: string) =>
    request<void>(`${pullPath(owner, repo, number)}/notes/hand-off`, postJson({ head_sha: headSha })),
  decideFinding: (owner: string, repo: string, number: number, findingKey: string, decision: FindingDecision | null) =>
    request<void>(`${pullPath(owner, repo, number)}/finding-decisions`, sendJson("PUT", { finding_key: findingKey, decision })),
}

/** Starts a generation job and reports its progress until it finishes or fails. */
async function runJob<R>(path: string, body: unknown, onProgress: (progress: JobProgress<R>) => void) {
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", ...postJson(body) })
    if (!res.ok) {
      onProgress({ type: "error", message: await errorMessage(res) })
      return
    }
    let finished = false
    await readEvents(res, (data) => {
      const progress = JSON.parse(data) as JobProgress<R>
      finished ||= progress.type === "done" || progress.type === "error"
      onProgress(progress)
    })
    if (!finished) onProgress({ type: "error", message: "The connection closed before the job finished" })
  } catch (err) {
    onProgress({ type: "error", message: err instanceof Error ? err.message : "Network error" })
  }
}
