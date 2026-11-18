.PHONY: build run clean

build:
	cargo build --release -p loupe-gateway
	mkdir -p bin && cp ../target/release/loupe-gateway bin/loupe-gateway

# Usage: make run server=http://localhost:5173
run:
	cargo run -p loupe-gateway -- login --server $(or $(server),http://localhost:5173)

clean:
	rm -rf ./bin
