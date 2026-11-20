# Loupe

AI-guided GitHub pull request review. Loupe surfaces what matters in a pull request and collapses what doesn't, then walks you through it.

- **Guided review**: a summary, a reading order, importance and concerns on every hunk, and diagrams where the flow is hard to follow.
- **Self-review**: problems found in your own draft, pinned to lines. Accept, edit or dismiss them, add your own comments, and export everything as markdown for an agent.
- **Bring your own model**: sign in with ChatGPT to use your plan, or use an OpenAI API key.

## How your data is handled

- **GitHub**: every request uses your own GitHub token, so you only ever see what you could see on github.com. Shared reviews are re-checked against your access before they're shown.
- **Inference credentials** (ChatGPT sign-in, API keys) live in a vault encrypted in your browser with a passkey or passphrase. The server stores the ciphertext but can't decrypt it; your browser sends a short-lived token with each review and the server keeps it in memory only for that job.
- **ChatGPT sign-in** happens on your own computer with `loupe-gateway`, which hands the tokens to your browser in a URL fragment (never sent to the server).
- **The model never runs anything.** It can only read the pull request's repository through read-only GitHub API calls pinned to the reviewed commits. Pull request content is treated as untrusted input throughout.

## Self-hosting

You need Docker, a domain with HTTPS in front of port 3000, and a GitHub account or organization to own Loupe's GitHub App.

1. Copy [`api/.env.example`](api/.env.example) to `.env` next to [`docker-compose.yml`](docker-compose.yml). Set `LOUPE_PUBLIC_URL` to your domain and `LOUPE_SECRET_KEY` to the output of `openssl rand -base64 32`. Leave the `GITHUB_*` lines empty.
2. `docker compose up -d`, then find the setup token in the log: `docker compose logs loupe | grep "setup token"`.
3. Open `https://your-domain/setup`, enter the token, and create the GitHub App. GitHub sends you back with three `GITHUB_*` lines: add them to `.env` and `docker compose up -d` again.
4. Install the app (the setup page links to it) on the accounts and organizations whose **private** repositories you want to review. Public repositories work without installing it.

The image is published to `ghcr.io/hisbaan/loupe`: `latest` and version tags on each release, and `canary` when you run the workflow by hand from `main`. It runs read-only, unprivileged and within 256 MB.

## Connecting ChatGPT

Install `loupe-gateway` on your own computer:

- **homebrew**: `brew install hisbaan/tap/loupe-gateway`
- **cargo**: `cargo install --git https://github.com/hisbaan/loupe loupe-gateway --locked`
- **nix**: `nix run github:hisbaan/loupe#gateway -- login --server https://your-domain`

Then run `loupe-gateway login --server https://your-domain`, sign in with ChatGPT in the browser window that opens, and save the sign-in to your vault when Loupe asks.

## Development

```sh
cp api/.env.example api/.env   # set LOUPE_SECRET_KEY; leave GITHUB_* empty to try setup
make dev                       # API on :3000, web on http://localhost:5173
make test && make lint
```

`nix develop` gives you the toolchain (Rust, Node, pnpm, overmind, cargo-watch). [`AGENTS.md`](AGENTS.md) covers the layout, conventions and security invariants; [`PLAN.md`](PLAN.md) the design and roadmap.

### Releasing

Publish a GitHub release (e.g. tag `v0.2.0`). That builds and publishes the Docker image to `ghcr.io/hisbaan/loupe` and uploads `loupe-gateway` binaries for macOS (Apple Silicon) and Linux (x86-64) with a `SHA256SUMS` file to the release. Bump `version` in [`gateway/Cargo.toml`](gateway/Cargo.toml) first so `loupe-gateway --version` matches. Both workflows can also be run by hand from the Actions tab: pick the release's tag under "Use workflow from".

Then update the formula in [hisbaan/homebrew-tap](https://github.com/hisbaan/homebrew-tap) with the new version, the macOS archive's URL and its checksum from `SHA256SUMS`.
