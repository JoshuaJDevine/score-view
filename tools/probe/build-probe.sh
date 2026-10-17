#!/usr/bin/env bash
# Builds the throwaway "Score View Probe" extension (not part of Score View) and installs it next to it.
#   bash tools/probe/build-probe.sh      (uses BITWIG_EXT_DIR or the same folder detection as build.sh)
set -euo pipefail
cd "$(dirname "$0")"
ROOT=../..
rm -rf build && mkdir -p build/classes/META-INF/services
javac --release 21 -Xlint:-options -cp $ROOT/lib/extension-api-25.jar -d build/classes src/jwv/probe/*.java
echo "jwv.probe.ProbeExtensionDefinition" > build/classes/META-INF/services/com.bitwig.extension.ExtensionDefinition
(cd build/classes && jar --create --file ../ScoreViewProbe.bwextension .)
DEST=${BITWIG_EXT_DIR:-}
if [ -z "$DEST" ]; then
  for d in "$HOME/OneDrive/Documents/Bitwig Studio/Extensions" "$HOME/Documents/Bitwig Studio/Extensions"; do
    if ls "$d"/*.bwextension >/dev/null 2>&1; then DEST=$d; break; fi
  done
fi
[ -n "$DEST" ] || { echo "Set BITWIG_EXT_DIR"; exit 1; }
cp build/ScoreViewProbe.bwextension "$DEST/"
# The MIDI file for P5 goes next to the log
PROBE_DIR="$(dirname "$DEST")/Score View Probe"; mkdir -p "$PROBE_DIR"
[ -f probe-cc.mid ] && cp probe-cc.mid "$PROBE_DIR/"
echo "Installed to $DEST/ScoreViewProbe.bwextension; files in $PROBE_DIR"
