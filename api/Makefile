ifneq (,$(wildcard ./.env))
    include .env
    export
endif

.PHONY: build run dev clean

build:
	cargo build --release -p loupe-api
	mkdir -p bin && cp ../target/release/loupe-api bin/loupe-api

run:
	./bin/loupe-api

# Restarts on change if cargo-watch is installed, otherwise runs once.
dev:
	@if command -v cargo-watch >/dev/null; then cargo watch -x 'run -p loupe-api'; else cargo run -p loupe-api; fi

clean:
	rm -rf ./bin
