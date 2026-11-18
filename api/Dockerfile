# Build context is the repo root: docker build -f api/Dockerfile .

FROM node:24-slim AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM rust:1-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p loupe-api

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=api /src/target/release/loupe-api /loupe-api
COPY --from=web /src/web/dist /web
ENV LOUPE_WEB_DIR=/web \
    LOUPE_DATABASE_URL=sqlite:///data/loupe.db \
    LOUPE_ADDR=0.0.0.0:3000
VOLUME /data
EXPOSE 3000
USER nonroot:nonroot
ENTRYPOINT ["/loupe-api"]
