#!/bin/bash
# Build whisper.cpp's whisper-cli into $1/bin (static, Metal on Apple Silicon).
# Used when Homebrew is missing or not writable. Needs git + Xcode CLT; cmake comes from uvx or PATH.
set -euo pipefail
DEST="${1:?usage: install-whisper.sh <dest-dir>}"
SRC="$DEST/src"
mkdir -p "$DEST/bin"

if command -v cmake >/dev/null 2>&1; then CMAKE=(cmake)
elif command -v uvx >/dev/null 2>&1; then CMAKE=(uvx cmake)
else echo "Need cmake (brew install cmake) or uv (https://docs.astral.sh/uv/)" >&2; exit 2
fi

echo "step: fetching whisper.cpp"
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only --quiet || true
else rm -rf "$SRC"; git clone --depth 1 --quiet https://github.com/ggml-org/whisper.cpp "$SRC"; fi

echo "step: configuring"
"${CMAKE[@]}" -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_METAL_EMBED_LIBRARY=ON >/dev/null

echo "step: compiling (a minute or two)"
"${CMAKE[@]}" --build "$SRC/build" --config Release -j "$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" --target whisper-cli >/dev/null

cp "$SRC/build/bin/whisper-cli" "$DEST/bin/whisper-cli"
rm -rf "$SRC/build"
echo "done: $DEST/bin/whisper-cli"
