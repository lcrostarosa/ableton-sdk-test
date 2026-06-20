#!/usr/bin/env bash
# Build + launch the Extension Host, streaming its log to BOTH the terminal and a file.
#
# Why no ExtensionHost.txt tail: in the dev flow `extensions-cli run` spawns the Extension
# Host with stdio:inherit, so the host's output — the timestamped `info:` lines, your
# extension's console.{log,error,info,warn}, and uncaught-exception stack traces — goes
# straight to THIS terminal. There is no ~/Library/Preferences/Ableton/Live <v>/ExtensionHost.txt
# in dev mode; Live only writes that file for a PACKAGED extension running inside Live with no
# CLI attached. So to get a persistent, tailable/greppable log we tee stdout into .logs/.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .logs
LOG=".logs/extension-host.log"

echo "[dev] building…"
npx tsx build.ts || exit 1

echo "[dev] launching Extension Host (Live from .env EXTENSION_HOST_PATH)"
echo "[dev] log streams below AND is saved to $LOG  (tail elsewhere with: npm run logs)"
echo "----------------------------------------------------------------------"
# stdio:inherit ⇒ the host writes to this pipeline's stdout; tee shows it live + persists it.
npx extensions-cli run 2>&1 | tee "$LOG"
