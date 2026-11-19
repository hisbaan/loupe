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

// Mirrors loupe_protocol::review::HunkKind.
export type HunkKind =
  | "code"
  | "import_only"
  | "lockfile"
  | "generated"
  | "vendored"
  | "rename"
  | "whitespace_only"
  | "docs"
  | "test"
  | "config"

// Mirrors api/src/prepass.
export type HunkAnalysis = {
  id: string
  header: string
  old_start: number
  old_lines: number
  new_start: number
  new_lines: number
  kind: HunkKind
  collapsible: boolean
  notes: string[]
}

export type FileAnalysis = {
  kind: HunkKind | null
  collapsible: boolean
  hunks: HunkAnalysis[]
}

export type AnalyzedFile = PullFile & {
  analysis: FileAnalysis
}

export type PullResponse = {
  pull: Pull
  files: AnalyzedFile[]
  truncated: boolean
}
