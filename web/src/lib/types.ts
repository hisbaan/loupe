// Mirrors api/src/pulls and api/src/auth response shapes.

export type Me = {
  login: string
  avatar_url: string | null
}

export type GitRef = {
  ref: string
  sha: string
}

export type Pull = {
  number: number
  title: string
  body: string | null
  state: string
  draft: boolean | null
  html_url: string
  user: { login: string; avatar_url: string | null }
  base: GitRef
  head: GitRef
}

export type PullFile = {
  filename: string
  previous_filename: string | null
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
  additions: number
  deletions: number
  patch: string | null
}

export type PullResponse = {
  pull: Pull
  files: PullFile[]
  truncated: boolean
}
