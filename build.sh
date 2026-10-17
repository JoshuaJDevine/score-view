#!/usr/bin/env bash
# Builds ScoreView.bwextension and installs it into Bitwig's user Extensions folder.
#
#   bash build.sh               build + install
#   bash build.sh --no-install  build only (build/ScoreView.bwextension)
#
# Install folder: $BITWIG_EXT_DIR if set, else detected: ~/Documents/Bitwig Studio/Extensions, or the OneDrive one
# (~/OneDrive/Documents/Bitwig Studio/Extensions) when OneDrive has taken over Documents. When both exist the OneDrive
# folder wins only if it already holds .bwextension files (that is the library Bitwig is using).
set -euo pipefail
cd "$(dirname "$0")"

INSTALL=1
for arg in "$@"; do
  case $arg in
    --no-install) INSTALL=0 ;;
    *) echo "unknown option: $arg (use --no-install)" >&2; exit 2 ;;
  esac
done

[ -f lib/extension-api-25.jar ] || node tools/fetch-api.mjs
rm -rf build && mkdir -p build/classes/web/vendor build/classes/META-INF/services
javac --release 21 -Xlint:-options -cp lib/extension-api-25.jar -d build/classes src/claude/scoreview/*.java
cp web/*.html web/*.js build/classes/web/
cp web/*.css build/classes/web/
mkdir -p build/classes/web/core && cp web/core/*.js build/classes/web/core/
mkdir -p build/classes/web/features && cp web/features/*.js web/features/*.json build/classes/web/features/
cp node_modules/verovio/dist/verovio-toolkit-wasm.js build/classes/web/vendor/
cp node_modules/fflate/umd/index.js build/classes/web/vendor/fflate.js
echo "claude.scoreview.ScoreViewExtensionDefinition" > build/classes/META-INF/services/com.bitwig.extension.ExtensionDefinition
(cd build/classes && jar --create --file ../ScoreView.bwextension .)

if [ $INSTALL -eq 0 ]; then echo "Built build/ScoreView.bwextension (not installed)"; exit 0; fi

ext_dir() {
  if [ -n "${BITWIG_EXT_DIR:-}" ]; then echo "$BITWIG_EXT_DIR"; return; fi
  local home=${USERPROFILE:-$HOME}
  [ -n "${USERPROFILE:-}" ] && command -v cygpath >/dev/null && home=$(cygpath -u "$USERPROFILE")
  local docs="$home/Documents/Bitwig Studio/Extensions" onedrive="$home/OneDrive/Documents/Bitwig Studio/Extensions"
  if [ -d "$onedrive" ] && { [ ! -d "$docs" ] || compgen -G "$onedrive/*.bwextension" >/dev/null; }; then echo "$onedrive"
  else echo "$docs"; fi
}
DEST=$(ext_dir)
mkdir -p "$DEST"
cp build/ScoreView.bwextension "$DEST/"
echo "Installed to $DEST/ScoreView.bwextension"
if [ -z "${BITWIG_EXT_DIR:-}" ]; then
  home=${USERPROFILE:-$HOME}
  [ -n "${USERPROFILE:-}" ] && command -v cygpath >/dev/null && home=$(cygpath -u "$USERPROFILE")
  if [ -d "$home/Documents/Bitwig Studio/Extensions" ] && [ -d "$home/OneDrive/Documents/Bitwig Studio/Extensions" ]; then
    echo "Note: both Documents and OneDrive/Documents have a Bitwig Studio/Extensions folder. If Bitwig does not list"
    echo "      Score View, set BITWIG_EXT_DIR to the folder Bitwig reads and run build.sh again."
  fi
fi
