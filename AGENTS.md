# AGENTS.md

## Purpose
- Guide for coding agents working in this repo: layout, commands, conventions, and the security invariants that must not regress.
- Product and roadmap context lives in `PLAN.md`.

## Repo Map
- `api/` Rust server binary (`loupe-api`): axum, SQLite (sqlx), serves the built `web/` bundle. Deployed in Docker.
- `gateway/` Rust CLI (`loupe-gateway`) that runs on a user's own machine and does "Sign in with ChatGPT". Separate binary from the server on purpose; never merge them.
- `crates/protocol/` Types shared by both binaries (handoff payload, review schema, hunk ids).
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

## Code Style: Rust
- `cargo fmt` (max width 120, `rustfmt.toml`). Edition 2024.
- API layout: one module per feature (`auth/`, `github/`, `pulls/`, `reviews/`, `vault/`) exposing `routes()`; mounted in `api/src/main.rs`. `prepass/` (diff classification) is a library; `inference/` is the Responses API client plus routes for the model list and the ChatGPT refresh relay.
- Handlers return `AppResult<T>`; map failures to `AppError` (`api/src/error.rs`). Never leak internal error text to clients.
- Auth: take `CurrentUser` as an extractor to require a session.
- SQL: runtime `sqlx::query`/`query_as` with `?` binds (no compile-time macros, so builds don't need a DB). Migrations in `api/migrations/`, applied on startup.
- Time is unix seconds (`INTEGER`) in SQLite.
- Never log or print tokens.

## Code Style: Web
- Double quotes, no semicolons, named exports, `type` for props, kebab-case filenames.
- Imports via `@/` alias. API calls go through `web/src/lib/api.ts` (returns `{ ok, status, data | error }`).
- In-app links use `Link` (`web/src/components/link.tsx`), not `<a>`: a full page load locks the vault, whose key lives only in memory.
- Vault: `web/src/lib/vault/` (WebCrypto + WebAuthn PRF, store); get a job's credential with `credentialFor()` in `web/src/lib/inference.ts`.
- `web/src/lib/types.ts` mirrors API response shapes; update both sides together.

## Security Invariants (do not regress)
- **GitHub access**: every GitHub call uses the requesting user's token (`github::user_token`). Anything cached and shared (reviews, blobs) must be access-checked against the requesting user's GitHub permissions before it is served.
- **Inference credentials**: the server never stores usable inference credentials. ChatGPT/API-key credentials live in a vault encrypted in the browser (vault key wrapped by passkey PRF or PBKDF2 passphrase); the server stores only ciphertext, salts and credential ids, and receives a credential per job, in memory only. The ChatGPT refresh relay (`inference/chatgpt.rs`) sees a refresh token in transit and must never store or log it. The decrypted vault key is never written to browser storage.
- **Gateway handoff**: tokens go gateway → browser via the URL fragment of `/connect`. Never move them into a query string or a server request.
- **LLM execution**: the model never triggers code execution on the host. Tools are in-process Rust functions doing read-only GitHub API GETs, pinned to the job's repo and base/head SHAs (not model-controlled). No clones, no subprocesses, no shell.
- **Pre-pass** (`api/src/prepass/`): the PR author controls its input. It may only err towards `Code`/not collapsible. Self-declared generated files (marker or name) collapse only if they already existed; whitespace inside a line is never ignored; indentation is significant in Python/YAML/Makefiles; side-effect imports are code; lockfiles from non-registry sources are shown.
- **Prompts**: PR content goes inside a per-request random delimiter and is described as untrusted. Bump `PROMPT_VERSION` on any prompt or input-format change.
- **Model output** is untrusted: parse into `loupe_protocol::review` types, reject reviews that miss hunks, and render mermaid with `securityLevel: "strict"`.

## Generated / Build Outputs
- `target/`, `*/bin/`, `web/dist/`, `*.db*` are build or runtime outputs.
