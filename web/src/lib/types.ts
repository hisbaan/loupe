// Mirrors api/src/pulls and api/src/auth response shapes.

// Mirrors api/src/setup.
export type ClientConfig = {
  github_configured: boolean
  install_url: string | null
}

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

// Mirrors pulls::list.
export type PullReason = "review_requested" | "authored" | "maintainer"

export type PullSummary = {
  repo: string
  number: number
  title: string
  author: { login: string; avatar_url: string | null }
  draft: boolean
  updated_at: string
  html_url: string
  reasons: PullReason[]
  base_ref: string
  head_ref: string
  /** The head branch is in a fork, so it can't be part of a stack. */
  cross_repository: boolean
}

export type PullListResponse = {
  pulls: PullSummary[]
  /** Some lookups failed, so pull requests may be missing. */
  partial: boolean
}

export type PullResponse = {
  pull: Pull
  files: AnalyzedFile[]
  truncated: boolean
}

// Mirrors api/src/pulls/stack.rs.
export type StackLayer = {
  number: number
  title: string
  state: "open" | "closed" | "merged"
  draft: boolean
}

export type Stack = {
  /** GitHub's stack number; null when worked out from branches. */
  number: number | null
  /** The branch the bottom layer targets. */
  base: string
  /** Bottom first. */
  layers: StackLayer[]
}

// Mirrors api/src/discussion. Timestamps are ISO 8601.
export type Actor = { login: string; avatar_url: string | null }

export type Connection<T> = { total_count: number; nodes: T[] }

export type DiscussionComment = {
  id: string
  body: string
  created_at: string
  url: string
  viewer_can_update: boolean
  viewer_can_delete: boolean
  /** null for deleted accounts. */
  author: Actor | null
  /** Review comments only: "PENDING" while in your unsubmitted review. */
  state: "PENDING" | "SUBMITTED" | null
}

export type SubmittedReview = {
  id: string
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"
  body: string
  submitted_at: string | null
  url: string
  author: Actor | null
  comments: Connection<unknown>
}

export type ReviewThread = {
  id: string
  path: string
  /** The line in the current diff; null when outdated. */
  line: number | null
  start_line: number | null
  original_line: number | null
  diff_side: "LEFT" | "RIGHT"
  is_resolved: boolean
  is_outdated: boolean
  viewer_can_resolve: boolean
  viewer_can_unresolve: boolean
  viewer_can_reply: boolean
  comments: Connection<DiscussionComment>
}

export type Discussion = {
  head_sha: string
  viewer_did_author: boolean
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  locked: boolean
  /** Your unsubmitted review, started here or on GitHub. */
  pending_review: { id: string; comments: number } | null
  /** Your latest submitted review. */
  viewer_review: { state: SubmittedReview["state"]; commit_sha: string | null } | null
  /** The conversation, oldest first. */
  comments: DiscussionComment[]
  /** Submitted reviews, oldest first. */
  reviews: SubmittedReview[]
  threads: ReviewThread[]
  /** GitHub had more than Loupe fetched. */
  truncated: boolean
}

export type ReviewEvent = "comment" | "approve" | "request_changes"

/** A new comment on a line range of the diff. */
export type LineCommentRequest = {
  head_sha: string
  path: string
  side: LineSide
  start_line: number
  end_line: number
  body: string
  /** Add to your pending review instead of posting now. */
  review: boolean
}

// Mirrors loupe_protocol::review.
export type Attention = "review_closely" | "read" | "skim"

export type Diagram = {
  kind: string
  source: string
  caption: string | null
}

export type Section = {
  title: string
  attention: Attention
  /** Markdown, shown above the section's code. */
  overview: string
  /** In reading order; every reviewable hunk is in exactly one section. */
  hunk_ids: string[]
  diagram: Diagram | null
}

export type Severity = "blocker" | "major" | "minor" | "nit"
export type Category = "bug" | "security" | "performance" | "design" | "convention" | "test" | "question" | "suspicious"
export type LineSide = "new" | "old"

/** A problem or question pinned to lines inside one hunk. */
export type Finding = {
  id: string
  hunk_id: string
  path: string
  side: LineSide
  start_line: number
  end_line: number
  severity: Severity
  category: Category
  title: string
  /** Markdown. */
  body: string
  suggestion: string | null
}

export type Review = {
  schema_version: number
  /** Markdown overview. */
  summary: string
  /** Most important first. */
  sections: Section[]
  findings: Finding[]
  hunk_notes: Record<string, string>
  questions: string[]
}

// Mirrors api/src/reviews/job.rs.
export type Effort = "quick" | "standard" | "thorough"

/** What every generation job is sent. */
export type JobRequest = {
  credential: Credential
  model: string
  effort: Effort
}

// Mirrors api/src/reviews.
export type ReviewRecord = {
  id: number
  model: string
  prompt_version: number
  base_sha: string
  head_sha: string
  created_at: number
  effort: Effort
  /** Repository files the model read. */
  files_read: string[]
  requested_by: { login: string; avatar_url: string | null }
  /** Covers the pull request's current base and head commits. */
  current: boolean
  trust: "mine" | "trusted" | "other"
  /** The viewer chose to see this requester's reviews without being asked. */
  auto_load: boolean
  /** The pull request's author requested this review of their own change. */
  requested_by_author: boolean
  updated_from: { login: string; head_sha: string } | null
  review: Review
}

// Mirrors api/src/trust.
export type TrustedReviewer = {
  login: string
  auto_load: boolean
}

/** Progress events from a generation job (`api/src/reviews/job.rs`). */
export type JobProgress<R> =
  | { type: "status"; message: string }
  | { type: "generating"; chars: number }
  | { type: "done"; record: R }
  | { type: "error"; message: string }

export type ReviewProgress = JobProgress<ReviewRecord>

// Mirrors api/src/notes: private notes for your coding agent.
export type AgentNote = {
  id: number
  path: string
  side: LineSide
  start_line: number
  end_line: number
  /** The commit the lines refer to. */
  head_sha: string
  /** The hunk the lines were in; while it's still in the diff, so are they. */
  hunk_id: string | null
  /** The lines as the diff showed them. */
  snippet: string | null
  body: string
  /** The review finding it was accepted from. */
  finding_key: string | null
  resolved: boolean
  /** The head commit when it was last handed to your agent. */
  handed_off_sha: string | null
  handed_off_at: number | null
  created_at: number
  updated_at: number
}

export type NewAgentNote = Pick<
  AgentNote,
  "path" | "side" | "start_line" | "end_line" | "head_sha" | "hunk_id" | "snippet" | "body" | "finding_key"
>

export type FindingDecision = "dismissed" | "github"

export type AgentNoteList = {
  /** Oldest first. */
  notes: AgentNote[]
  decisions: { finding_key: string; decision: FindingDecision }[]
}

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
