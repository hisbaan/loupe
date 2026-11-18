.PHONY: help dev dev/api dev/web build build/api build/gateway build/web run run/api run/web clean clean/api clean/gateway clean/web test lint fmt docker

help:
	@echo "Available commands:"
	@echo "  make dev                Run api + web in development mode (via overmind)"
	@echo "  make dev/api            Run only the API in dev mode"
	@echo "  make dev/web            Run only the web app in dev mode"
	@echo "  make build              Build everything"
	@echo "  make build/api          Build the API binary"
	@echo "  make build/gateway      Build the local ChatGPT sign-in gateway"
	@echo "  make build/web          Build the web bundle"
	@echo "  make run                Run built services via overmind"
	@echo "  make test               Run Rust tests"
	@echo "  make lint               cargo clippy + oxlint"
	@echo "  make fmt                cargo fmt"
	@echo "  make docker             Build the server image (api + web)"
	@echo "  make clean              Clean build artifacts"

dev:
	overmind start -f Procfile

dev/api:
	$(MAKE) -C api dev

dev/web:
	pnpm --dir web dev

build: build/api build/gateway build/web

build/api:
	$(MAKE) -C api build

build/gateway:
	$(MAKE) -C gateway build

build/web:
	pnpm --dir web build

run:
	overmind start -f Procfile.run

run/api:
	$(MAKE) -C api run

run/web:
	pnpm --dir web preview

clean: clean/api clean/gateway clean/web

clean/api:
	$(MAKE) -C api clean

clean/gateway:
	$(MAKE) -C gateway clean

clean/web:
	rm -rf web/dist

test:
	cargo test --workspace

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm --dir web lint

fmt:
	cargo fmt --all

docker:
	docker build -f api/Dockerfile -t loupe .
