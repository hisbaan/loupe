import type { Me, PullResponse } from "@/lib/types"

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string }

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init })
    if (res.ok) return { ok: true, status: res.status, data: (await res.json()) as T }
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    return { ok: false, status: res.status, error: body?.error ?? res.statusText }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Network error" }
  }
}

export const api = {
  me: () => request<Me>("/me"),
  pull: (owner: string, repo: string, number: number) =>
    request<PullResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`),
}
