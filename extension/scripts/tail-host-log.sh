#!/usr/bin/env bash
# Tail the Extension Host log.
#  • Dev flow (npm start): the host streams to stdout, which dev.sh tees into .logs/.
#  • Packaged flow (extension installed, run inside Live with no CLI): Live writes its own
#    ~/Library/Preferences/Ableton/Live <version>/ExtensionHost.txt — we fall back to that.
set -uo pipefail
cd "$(dirname "$0")/.."
DEV_LOG=".logs/extension-host.log"
PREFS="$HOME/Library/Preferences/Ableton"

if [ -f "$DEV_LOG" ]; then
  echo "[logs] tailing dev log: $DEV_LOG"
  echo "----------------------------------------------------------------------"
  exec tail -n 200 -F "$DEV_LOG"
fi

echo "[logs] no dev log yet; checking for Live's own ExtensionHost.txt (packaged flow)…"
LOG="$(ls -t "$PREFS"/Live*/ExtensionHost.txt 2>/dev/null | head -1 || true)"
if [ -n "$LOG" ]; then
  echo "[logs] tailing: $LOG"
  echo "----------------------------------------------------------------------"
  exec tail -n 200 -F "$LOG"
fi

echo "[logs] Nothing to tail. Run 'npm start' first (dev), or install/package the extension."
exit 1
