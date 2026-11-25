# AGENTS.md

## Purpose
- Guide for coding agents working in this repo: layout, commands, conventions, and the security invariants that must not regress.
- Product and roadmap context lives in `PLAN.md`.

## Repo Map
- `api/` Rust server binary (`loupe-api`): axum, SQLite (sqlx), serves the built `web/` bundle. Deployed in Docker.
- `gateway/` Rust CLI (`loupe-gateway`) that runs on a user's own machine and does "Sign in with ChatGPT". Separate binary from the server on purpose; never merge them.
- `crates/protocol/` Types shared by both binaries (handoff payload, review and self-review schemas, hunk ids).
- `web/` Vite + React 19 + Tailwind v4 SPA; diffs render with `@pierre/diffs`.
- Root `Cargo.toml` is the workspace; root `Makefile` + `Procfile` orchestrate (Overmind), same pattern as `../auth`.

## Build / Run / Lint / Test
- Dev (api + web): `make dev`. Web is http://localhost:5173 and proxies `/api` and `/auth` to the API on :3000.
- API only: `make dev/api` (needs `api/.env`, see `api/.env.example`). Web only: `make dev/web`.
- Build all: `make build`. Server image: `make docker` (context is repo root, `api/Dockerfile`).
- Gateway against local dev: `make -C gateway run` or `cargo run -p loupe-gateway -- login --server http://localhost:5173`.
- Tests: `make test` (`cargo test --workspace`); single test: `cargo test -p loupe-api crypto::tests::round_trip`.
- Lint: `make lint` (clippy with `-D warnings` + oxlint). Format: `make fmt`.
- Web type-check + build: `pnpm --dir web build`.
- Gateway with Nix: `nix build .#gateway`; dev shell: `nix develop`.
- Releases: publishing a GitHub release builds the Docker image (`ghcr.io/hisbaan/loupe`) as `latest` + version tags and uploads gateway binaries + `SHA256SUMS` (see README); running the image workflow by hand from `main` publishes `canary`. The Homebrew formula lives in hisbaan/homebrew-tap.

## Code Style: Rust
- `cargo fmt` (max width 120, `rustfmt.toml`). Edition 2024.
- API layout: one module per feature (`auth/`, `discussion/`, `github/`, `pulls/`, `reviews/`, `setup/`, `trust/`, `vault/`) exposing `routes()`; mounted in `api/src/main.rs`. `discussion/` is the pull request's conversation, review threads and reviews on GitHub, read and written; `pulls/stack.rs` finds stacked pull requests. `prepass/` (diff classification) and `source/` (repo trees and blobs at pinned SHAs via the GitHub API, cached in SQLite) are libraries; `inference/` is the Responses API client plus routes for the model list and the ChatGPT refresh relay.
- Handlers return `AppResult<T>`; map failures to `AppError` (`api/src/error.rs`). Never leak internal error text to clients.
- Auth: take `CurrentUser` as an extractor to require a session.
- SQL: runtime `sqlx::query`/`query_as` with `?` binds (no compile-time macros, so builds don't need a DB). Migrations in `api/migrations/`, applied on startup.
- Time is unix seconds (`INTEGER`) in SQLite.
- Never log or print tokens. The one exception is the first-run setup token (`setup/`), which exists to be read from the log.
- `GITHUB_*` config is optional: use `state.config.github()?` (returns `NotConfigured` in setup mode), never unwrap.

## Code Style: Web
- Double quotes, no semicolons, named exports, `type` for props, kebab-case filenames.
- Imports via `@/` alias. API calls go through `web/src/lib/api.ts` (returns `{ ok, status, data | error }`).
- In-app links use `Link` (`web/src/components/link.tsx`), not `<a>`, so navigation keeps loaded state.
- Vault: `web/src/lib/vault/` (WebCrypto + WebAuthn PRF, store, remembered key); get a job's credential with `credentialFor()` in `web/src/lib/inference.ts`.
- `web/src/lib/types.ts` mirrors API response shapes; update both sides together.

## Security Invariants (do not regress)
- **GitHub access**: every GitHub call uses the requesting user's token (`github::user_token`). Anything cached and shared (reviews, blobs) must be access-checked against the requesting user's GitHub permissions before it is served.
- **Inference credentials**: the server never stores usable inference credentials. ChatGPT/API-key credentials live in a vault encrypted in the browser (vault key wrapped by passkey PRF or PBKDF2 passphrase); the server stores only ciphertext, salts and credential ids, and receives a credential per job, in memory only. The ChatGPT refresh relay (`inference/chatgpt.rs`) sees a refresh token in transit and must never store or log it. The unlocked vault key may be remembered in the browser's IndexedDB (`web/src/lib/vault/remembered.ts`) so the vault stays unlocked on that computer; it's forgotten on lock, sign-out or when the page loads without a session, and never sent to the server. Decrypted vault contents are never written to browser storage.
- **Setup** (`setup/`): only active while the GitHub App isn't configured; every step requires the logged one-time token, manifest `state` values are single-use, and the resulting credentials are returned once and never stored.
- **Gateway handoff**: tokens go gateway → browser via the URL fragment of `/connect`. Never move them into a query string or a server request.
- **LLM execution**: the model never triggers code execution on the host. Tools (`api/src/reviews/tools.rs`) are in-process Rust functions doing read-only GitHub API GETs through `source::Source`, pinned to the job's repo and base/head SHAs (not model-controlled; the model picks only side, path and pattern). Paths resolve only through the commit's tree. Regexes use the linear-time `regex` crate with size limits. Calls and output bytes are budgeted. No clones, no subprocesses, no shell.
- **Self-reviews** (`reviews/self_review/`) are private: every query is scoped to the requesting `user_id`, and listing still re-fetches the pull request with the user's token. Findings must point at lines inside a reviewable hunk (`output::parse`). Generated reviews of any kind go through `reviews/job.rs` (SSE progress, tool loop).
- **Shared reviews**: trust (`trust/`) only changes what's offered or auto-shown; it never grants access. Incremental updates (`based_on`) may only start from the requester's own or a trusted reviewer's review of the same pull request, and record `based_on` so provenance shows it.
- **GitHub writes** (`discussion/`, the only writes; the app has `pull_requests: write` and `contents: read`): made only on an explicit user request, with the user's token, through `github::send_json`/`github::mutate`; never from model output or inside a review job. Line comments and reviews carry the head SHA the user saw and are refused (409) if the pull request moved, so an approval never covers unseen commits. GitHub comment bodies (and PR descriptions) are other people's markdown: render them only through `web/src/components/markdown.tsx` (React elements, raw HTML dropped, links limited to http(s)/mailto, images only from GitHub hosts), never as HTML (no `rehype-raw`, no `bodyHTML`, no `dangerouslySetInnerHTML`).
- **Stacks** (`pulls/stack.rs`): GitHub's `/repos/{o}/{r}/stacks` endpoint is undocumented (it's what `gh stack` uses), so it's best-effort with a fallback to following branches; never rely on it for anything access-related.
- **Source cache**: `source_trees`/`source_blobs` are shared across users and keyed by `repo_id`; only build a `Source` from a pull request fetched with the requesting user's token.
- **Pre-pass** (`api/src/prepass/`): the PR author controls its input. It may only err towards `Code`/not collapsible. Self-declared generated files (marker or name) collapse only if they already existed; whitespace inside a line is never ignored; indentation is significant in Python/YAML/Makefiles; side-effect imports are code; lockfiles from non-registry sources are shown.
- **Prompts**: PR content, and tool output (repository files), goes inside a per-request random delimiter and is described as untrusted. Bump `PROMPT_VERSION` on any prompt or input-format change.
- **Model output** is untrusted: parse into `loupe_protocol::review` types, reject reviews that miss hunks, and render mermaid only through `web/src/lib/mermaid.ts` (pele, flowcharts and sequence diagrams only, links and images off, shown as an `<img>`, never inserted as SVG/HTML).

## Generated / Build Outputs
- `target/`, `*/bin/`, `web/dist/`, `*.db*` are build or runtime outputs.
