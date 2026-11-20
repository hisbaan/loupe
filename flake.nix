{
  description = "Loupe: AI-guided GitHub pull request review";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      gatewayToml = builtins.fromTOML (builtins.readFile ./gateway/Cargo.toml);
    in
    {
      packages = forAllSystems (pkgs: rec {
        # `nix run github:hisbaan/loupe#gateway -- login --server https://loupe.example.com`
        gateway = pkgs.rustPlatform.buildRustPackage {
          pname = "loupe-gateway";
          version = gatewayToml.package.version;
          # The whole workspace is needed to resolve it, but not web/ or build output.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./Cargo.toml
              ./Cargo.lock
              ./api
              ./gateway
              ./crates
            ];
          };
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [
            "-p"
            "loupe-gateway"
          ];
          cargoTestFlags = [
            "-p"
            "loupe-gateway"
          ];
          # rustls' crypto provider (aws-lc-sys) links nixpkgs' AWS-LC.
          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = [ pkgs.aws-lc ];
          meta = {
            description = gatewayToml.package.description;
            homepage = "https://github.com/hisbaan/loupe";
            license = pkgs.lib.licenses.mit;
            mainProgram = "loupe-gateway";
          };
        };
        default = gateway;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            cargo
            rustc
            rustfmt
            clippy
            rust-analyzer
            cargo-watch
            cmake
            nodejs
            pnpm
            overmind
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
