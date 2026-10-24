#!/bin/bash
# Builds AlimangoPDF.app (macOS). Needs Homebrew node and qpdf:  brew install node qpdf
# Usage: ./build.sh [destination folder]   (default: ~/Applications)
set -euo pipefail
cd "$(dirname "$0")"
DEST="${1:-$HOME/Applications}"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found: brew install node"; exit 1; }
[ -x /opt/homebrew/bin/qpdf ] || echo "warning: /opt/homebrew/bin/qpdf not found (brew install qpdf); the engine needs it"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
sed "s#__NODE__#$NODE#" app/AlimangoPDF.applescript > "$BUILD/main.applescript"
osacompile -o "$BUILD/AlimangoPDF.app" "$BUILD/main.applescript"

ENGINE="$BUILD/AlimangoPDF.app/Contents/Resources/engine"
mkdir -p "$ENGINE"
cp engine/make-flexible.cjs engine/make-blank.cjs engine/package.json engine/package-lock.json "$ENGINE/"
(cd "$ENGINE" && npm ci --omit=dev --no-audit --no-fund --silent)

PL="$BUILD/AlimangoPDF.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName AlimangoPDF" "$PL"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string app.alimango.pdf" "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.alimango.pdf" "$PL"
codesign --force --deep -s - "$BUILD/AlimangoPDF.app"

mkdir -p "$DEST"
if [ -e "$DEST/AlimangoPDF.app" ]; then
  mv "$DEST/AlimangoPDF.app" "$HOME/.Trash/AlimangoPDF $(date +%Y%m%d-%H%M%S).app"
  echo "previous AlimangoPDF.app moved to Trash"
fi
cp -R "$BUILD/AlimangoPDF.app" "$DEST/"
echo "installed: $DEST/AlimangoPDF.app"
