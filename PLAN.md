# Loupe: plan

AI-guided GitHub pull request review. Surfaces what matters (business logic, routing, algorithms) and collapses what doesn't (imports, lockfiles, generated code). Self-hosted: one server binary plus SQLite in Docker, light enough for a homelab that is also a gaming PC.

## Architecture

```
Browser (web/: React + @pierre/diffs)
  │  passkey (WebAuthn PRF) unlocks the inference vault locally
  │  sends a short-lived access token with each review job
  ▼
loupe-api (api/: axum + SQLite)
  ├─ GitHub App sign-in; all GitHub calls use the requesting user's token
  ├─ deterministic pre-pass (hunk kinds)
  ├─ LLM orchestration over the Responses API (no hosted tools)
  │    └─ read-only tools: list_files / read_file / grep via GitHub API at pinned SHAs
  ├─ review cache + provenance, access-checked on read
  └─ encrypted vault blobs (server cannot decrypt)

loupe-gateway (gateway/, runs on the user's machine)
  └─ Sign in with ChatGPT: PKCE + 127.0.0.1 loopback → /connect#<tokens> → browser vault
```

### Why the server runs inference but holds no credentials
- The server makes the model call itself, so cached reviews are real model output. Clients never upload results, so they can't forge them.
- The browser holds the refresh token (in the vault) and sends only the 1-hour access token per job. Refreshes currently go through a server relay (the refresh token is seen in transit, never stored) because CORS on `auth.openai.com` is untested.

### No sandbox needed
The model can't execute anything: the server gets text back and validates it against a schema. Tools are Rust functions doing GitHub API GETs. The repo, SHAs and user token are bound by the job and aren't tool arguments, so a prompt injection can't read a different repo into a shared cache. If shell-capable agents are ever wanted, they don't run on this host (that would need a per-job Firecracker VM).

### Remaining threat: prompt injection in PR content
- Deterministic floors: hunks the pre-pass labels `code` with control-flow changes can be dimmed, never collapsed, by the model alone.
- Coverage: a review must assess every hunk id (`GuidedReview::missing_hunks`).
- Collapsed is never hidden.
- Provenance: who requested a review, model, prompt version and custom instructions are stored and shown. Reviews requested by the PR author get a badge.

## Code access (no clones)
| Need | API |
|---|---|
| Diff | `GET /pulls/{n}/files` (3000-file cap; fetch blobs and diff locally when `patch` is missing) |
| Tree | `GET /git/trees/{sha}?recursive=1` (includes blob SHAs) |
| File | `GET /git/blobs/{sha}` or `/contents/{path}?ref=` |
| Batch | GraphQL `object(expression: "<sha>:<path>")` with aliases |

Blobs are immutable, so they're cached forever by `(repo_id, blob_sha)`, still behind access checks. No GitHub code search exists for PR heads: `grep` runs in-process (Rust `regex`, linear time) over a capped set of fetched files. Per-review budgets: ~30 tool calls, byte and line caps. SIWC has no `previous_response_id` over HTTP, so the server resends the conversation each round; keep tool output trimmed.

## Review schema
`crates/protocol/src/review.rs`: summary, walkthrough steps (with optional mermaid diagram), per-hunk importance, rationale and concerns, questions. Versioned; cache keys include `SCHEMA_VERSION`.

Cache keys:
- Whole review: `(repo_id, pr, base_sha, head_sha, model, prompt_version, schema_version, instructions_hash)`
- Per file: `(repo_id, patch_hash, model, prompt_version)`, for incremental re-review after a push.

## Features
- **Guided review**: walkthrough sidebar drives scroll; low-importance and deterministic hunks are collapsed; rationale as `@pierre/diffs` line annotations.
- **Mermaid diagrams**: the model adds a flow diagram to a step when useful. Drawn with lazy-loaded `pele` (flowcharts and sequence diagrams only, links and images off), show source on parse failure.
- **Review on GitHub from Loupe**: GitHub's review threads inline in the diff, replies, resolve, line comments into your pending review, and submitting comment / approve / request changes, so you never need github.com to review.
- **Stacks**: stacked pull requests shown as a stack (GitHub's stacks, or branch chains), each layer reviewed on its own with the rest of the stack as context.
- **Self-review**: draft PRs or any `base...head`. A problem-finding prompt; human comments plus AI suggestions to accept, edit or dismiss; export markdown pinned to head SHA with `path:line` ranges and snippets for a coding agent.
- **Sharing**: per-user trusted GitHub logins (optional org defaults). Opening a PR with a matching cached review prompts "@alice generated a guided review 2h ago with <model>. Use it / generate my own". Trusted sources can auto-load.

## Inference credentials
- **Vault**: WebAuthn PRF → HKDF → AES-GCM key, derived in the browser. The server stores `(credential_id, prf_salt, ciphertext, version)`. Writes use compare-and-swap on `version` because SIWC refresh tokens rotate. Multiple passkeys wrap one vault key; passphrase fallback for browsers without PRF.
- **ChatGPT (SIWC)**: `loupe-gateway login --server <url>`. Registration state (`ext_agent_host_id`, issued `client_id`) in `~/.config/loupe/gateway.json` (0600). Tokens are never stored by the gateway.
- **API keys**: entered in the browser, stored in the same vault.

## Milestones
0. [x] Scaffold: workspace, Makefiles/Procfiles, Dockerfile, GitHub App sign-in + sessions, PR diff view with `@pierre/diffs`, gateway sign-in flow.
1. [ ] Experiments: SIWC CORS for `/v1/responses` and the token endpoint from a browser origin; `text.format: json_schema` under SIWC; first real gateway sign-in end to end.
2. [x] Deterministic pre-pass (`api/src/prepass/`: import-only, lockfile with unusual-source check, generated/vendored, rename, whitespace) and hunk-level collapse UI.
   - [ ] Follow-up: honour `linguist-generated` from `.gitattributes` *at the base SHA* (the PR can edit it at head).
3. [x] Guided review with a pasted API key: prompt (`api/src/reviews/prompt.rs`), strict structured output, SSE progress, coverage validation, review cache keyed by (repo, PR, base, head, model, prompt, schema) and access-checked by refetching the PR with the reader's token.
   - [ ] Large PRs: per-file pass + synthesis instead of the single-pass size limit.
   - [ ] One repair retry when the model skips hunks.
   - [ ] Deduplicate concurrent jobs for the same cache key.
4. [x] Passkey vault (`api/src/vault/`, `web/src/lib/vault/`): PRF → HKDF wraps a random vault key, passphrase (PBKDF2, 600k) fallback, several keys per vault, compare-and-swap writes. ChatGPT via the gateway handoff into the vault; per-job credentials; refresh relayed by the server (`POST /api/inference/chatgpt/refresh`) and serialised across tabs with Web Locks.
   - [ ] Decided: keep the relay until the milestone 1 CORS test. If `auth.openai.com` accepts browser requests, refresh straight from the browser and delete the relay; if not, keep the relay.
   - [x] Stays unlocked on that computer: the vault key is remembered in IndexedDB until lock or sign-out.
5. [x] Read-only GitHub tools + blob cache: `list_files`, `read_file`, `grep` (`api/src/reviews/tools.rs`) over `api/src/source/` (trees and blobs by SHA, cached in SQLite, pruned after 30 days). Multi-turn function calling with `store: false` (conversation resent each turn, reasoning echoed back encrypted); budgets of 25 calls, 150 KB of tool output and 10 turns; tools disabled above 150k characters of diff.
   - [ ] Verify `include: ["reasoning.encrypted_content"]` and echoed items are accepted under Sign in with ChatGPT and by non-reasoning models (milestone 1).
   - [ ] Show which files the model read in the review's provenance.
6. [x] Sharing: per-user trusted reviewers with auto-load (`api/src/trust/`), "@x generated a review… use it?" offer, provenance badges (yours, trusted, requested by PR author, earlier commit, updated from), one review per requester per cache key, incremental update from an earlier review (unchanged hunk ids keep their assessments; only new hunks go to the model).
   - [ ] Org-level default trusted reviewers.
   - [ ] Re-review only changed files' context when updating (today the whole PR's file list and description are resent).
7. [x] Mermaid diagrams: lazy-loaded `pele` (a small mermaid renderer: flowcharts and sequence diagrams only, labels escaped, links and images off), rendered as an `<img>` data URL so the SVG can never script the page; source shown on parse failure. Diagrams sit under the summary; walkthrough steps link to them.
8. [x] Self-review (`api/src/reviews/self_review/`, `web/src/components/self-review.tsx`): a problem-finding prompt over line-numbered hunks; findings validated against hunk line ranges; private to the requester; accept / edit / dismiss plus your own comments via the diff gutter (stored as client-owned `notes_json`); markdown export pinned to the head SHA with path:line ranges and snippets (`web/src/lib/self-review.ts`). Defaults to the self-review tab on draft pull requests. Shared generation plumbing moved to `api/src/reviews/job.rs`.
   - [ ] Self-review any `base...head` (compare API), not just pull requests.
   - [ ] Comment without running the model first.
9. [x] Gateway releases (`.github/workflows/gateway-release.yml`, on release published or run by hand): macOS arm64 and Linux x86-64 binaries plus `SHA256SUMS` uploaded to the release; the Homebrew formula lives in hisbaan/homebrew-tap; no code signing. Linux users can `cargo install --git`. Nix flake with `packages.gateway` and a dev shell. First-run GitHub App setup (`api/src/setup/`): without `GITHUB_*` the server logs a one-time setup token and serves `/setup`, which creates the app from a manifest and shows the `.env` lines to paste (nothing stored). README for self-hosting.
   - [ ] Publish `loupe-gateway` to crates.io.
10. [x] Reviewing from Loupe (`api/src/discussion/`, `web/src/components/conversation.tsx`, `review-panel.tsx`, `review-thread.tsx`): the GitHub App asks for `pull_requests: write` (existing apps change it by hand, see README). Conversation tab with the description, comments, reviews and every thread; threads inline in the guided review's diff, with reply, resolve and edit/delete; gutter comments posted alone or into the user's pending review on GitHub (so a review in progress survives reloads and is shared with github.com); submit as comment / approve / request changes. Writes are pinned to the head SHA on screen. "Open on GitHub" on the page and each file.
   - [ ] Render comment markdown safely (today it's plain text; GitHub's `bodyHTML` would put third-party HTML on the vault's origin).
   - [ ] Threads in the self-review diff, and posting accepted self-review findings to GitHub as a review.
   - [ ] Paginate past 100 comments / reviews / threads (today: a "see the rest on GitHub" notice).
   - [ ] Request reviewers; merge, auto-merge and the merge queue (needs `contents: write`).
11. [x] Stacks (`api/src/pulls/stack.rs`, `web/src/components/stack-nav.tsx`): GitHub's stack for a pull request (`GET /repos/{o}/{r}/stacks?pull_request=N`, undocumented, used by `gh stack`), else a chain of open same-repo pull requests by base/head branch. Stack navigator on the pull page; home list groups stacks; the guided review prompt lists the stack (prompt version 4).
   - [ ] Merge a stack up to a layer (`PUT /pulls/{n}/merge-async`, also undocumented).
   - [ ] Whole-stack diff (trunk...top) via the compare API.
