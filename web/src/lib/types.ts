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

// Mirrors loupe_protocol::review.
export type Importance = "critical" | "normal" | "low"

export type Diagram = {
  kind: string
  source: string
  caption: string | null
}

export type WalkthroughStep = {
  title: string
  why: string
  hunk_ids: string[]
  diagram: Diagram | null
}

export type HunkAssessment = {
  importance: Importance
  rationale: string
  concerns: string[]
}

export type GuidedReview = {
  schema_version: number
  summary: string
  walkthrough: WalkthroughStep[]
  hunks: Record<string, HunkAssessment>
  questions: string[]
}

// Mirrors api/src/reviews.
export type ReviewRecord = {
  id: number
  model: string
  prompt_version: number
  base_sha: string
  head_sha: string
  created_at: number
  requested_by: { login: string; avatar_url: string | null }
  /** Covers the pull request's current base and head commits. */
  current: boolean
  trust: "mine" | "trusted" | "other"
  /** The viewer chose to see this requester's reviews without being asked. */
  auto_load: boolean
  /** The pull request's author requested this review of their own change. */
  requested_by_author: boolean
  updated_from: { login: string; head_sha: string } | null
  review: GuidedReview
}

// Mirrors api/src/trust.
export type TrustedReviewer = {
  login: string
  auto_load: boolean
}

export type ReviewProgress =
  | { type: "status"; message: string }
  | { type: "generating"; chars: number }
  | { type: "done"; record: ReviewRecord }
  | { type: "error"; message: string }

// Mirrors api/src/inference::Credential: sent with each job, never stored.
export type Credential = { kind: "api_key"; token: string } | { kind: "chatgpt"; token: string }

// Mirrors loupe_protocol::siwc::Tokens.
export type ChatGptTokens = {
  access_token: string
  refresh_token: string | null
  id_token: string | null
  expires_at: number
  scope: string
}

// Mirrors api/src/vault. Binary fields are unpadded base64url.
export type VaultKeyRecord = {
  id: number
  kind: "passkey" | "passphrase"
  label: string
  credential_id: string | null
  salt: string
  iterations: number | null
  wrapped_key: string
  created_at: number
}

export type VaultRecord = {
  version: number
  ciphertext: string
  keys: VaultKeyRecord[]
}

export type NewVaultKey =
  | { kind: "passkey"; label: string; credential_id: string; salt: string; wrapped_key: string }
  | { kind: "passphrase"; label: string; salt: string; iterations: number; wrapped_key: string }
