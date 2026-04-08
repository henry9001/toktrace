#!/usr/bin/env bash
#
# Build a standalone toktrace binary using Node.js Single Executable Application (SEA).
#
# Prerequisites: Node.js >= 20, npm dependencies installed, project built (npm run build).
#
# Usage:
#   ./scripts/build-sea.sh            # Build for current platform
#   ./scripts/build-sea.sh --output toktrace-linux-x64  # Custom output name
#
# The resulting binary can run without Node.js installed on the target machine.
# Note: native modules (better-sqlite3) are bundled via the CJS build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"

# Parse arguments
OUTPUT_NAME="toktrace"
while [[ $# -gt 0 ]]; do
  case $1 in
    --output) OUTPUT_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

OUTPUT_BIN="$DIST_DIR/$OUTPUT_NAME"

echo "==> Building toktrace standalone binary (Node.js SEA)"

# Step 1: Ensure CJS CLI bundle exists
if [ ! -f "$DIST_DIR/cli-sea.cjs" ]; then
  echo "    Building CJS bundle..."
  cd "$PROJECT_DIR"
  npm run build
fi

# Step 2: Generate the SEA preparation blob
echo "    Generating SEA blob..."
cd "$PROJECT_DIR"
node --experimental-sea-config sea-config.json

# Step 3: Copy the Node.js binary
echo "    Copying node binary..."
NODE_BIN="$(command -v node)"
cp "$NODE_BIN" "$OUTPUT_BIN"

# Step 4: Remove existing signature (macOS only)
if [ "$(uname)" = "Darwin" ]; then
  echo "    Removing code signature (macOS)..."
  codesign --remove-signature "$OUTPUT_BIN" 2>/dev/null || true
fi

# Step 5: Inject the SEA blob using postject
echo "    Injecting SEA blob..."
POSTJECT_ARGS=(
  "$OUTPUT_BIN"
  NODE_SEA_BLOB
  "$DIST_DIR/sea-prep.blob"
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
)

if [ "$(uname)" = "Darwin" ]; then
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi

npx --yes postject "${POSTJECT_ARGS[@]}"

# Step 6: Re-sign (macOS only)
if [ "$(uname)" = "Darwin" ]; then
  echo "    Re-signing binary (macOS)..."
  codesign --sign - "$OUTPUT_BIN"
fi

# Step 7: Make executable
chmod +x "$OUTPUT_BIN"

echo "==> Done: $OUTPUT_BIN"
echo "    Size: $(du -h "$OUTPUT_BIN" | cut -f1)"
echo "    Test: $OUTPUT_BIN --version"
