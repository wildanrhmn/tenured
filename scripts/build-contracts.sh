#!/bin/sh
# Builds both contracts into contracts/target/near/<name>/<name>.wasm
set -e
cd "$(dirname "$0")/../contracts"
for c in verifier lane; do
  (cd "$c" && cargo near build non-reproducible-wasm --no-abi)
done
