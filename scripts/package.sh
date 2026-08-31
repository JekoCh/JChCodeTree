#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p version/old
shopt -s nullglob
for f in version/*.vsix; do
  mv "$f" version/old/
done
shopt -u nullglob

rm -rf out
npm run compile
npx vsce package -o version/
