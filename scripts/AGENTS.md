<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# scripts

## Purpose
Shell helpers for the local dev loop: building the extension and launching the Extension Host
against a real Ableton Live build, and tailing that host's log output.

## Key Files
| File | Description |
|------|-------------|
| `dev.sh` | `npm start` target. Runs `tsx build.ts`, then `extensions-cli run`, teeing the host's stdout to both the terminal and `../.logs/extension-host.log` |
| `tail-host-log.sh` | `npm run logs` target. Tails `../.logs/extension-host.log` if present, else falls back to Live's packaged `~/Library/Preferences/Ableton/Live*/ExtensionHost.txt` |

## For AI Agents

### Working In This Directory
- Both scripts open with `cd "$(dirname "$0")/.."` — they assume they live directly under the
  project root in `scripts/` and operate relative to that root. Preserve this if you add scripts.
- `dev.sh`'s header comment explains *why* the `tee` exists: in dev mode `extensions-cli run`
  spawns the host with `stdio:inherit` and there is no `ExtensionHost.txt` — Live only writes that
  file for a packaged extension running with no CLI attached. The tee is what makes the log
  persistent and greppable (`npm run logs`) during development.
- `extensions-cli run` reads `EXTENSION_HOST_PATH` from `../.env` to decide which local Ableton
  Live build to launch.
- If you change the log filename or location, update both scripts together — `tail-host-log.sh`'s
  fallback logic and comments document the dev-vs-packaged distinction and need to stay consistent.

### Testing Requirements
- Run `bash scripts/dev.sh` (or `npm start`) and confirm the build succeeds and the Extension Host
  launches; `Ctrl-C` stops it. Requires `.env` configured with a Live build that has extension
  support enabled (the Beta line, per `.env`'s comment).
- Run `bash scripts/tail-host-log.sh` (or `npm run logs`) while `dev.sh` is running (or after a
  packaged install) to confirm log discovery works in both modes.

### Common Patterns
- `set -uo pipefail` + `cd "$(dirname "$0")/.."` at the top of each script, so they're runnable
  from any working directory (e.g. via `npm run`, which cwd's to the project root anyway, or
  invoked directly as `bash scripts/dev.sh` from elsewhere).

## Dependencies

### Internal
- `../build.ts`, `../manifest.json` — what gets built and where the bundle lands (`dist/extension.js`)
- `../.env` — `EXTENSION_HOST_PATH`, consumed by `extensions-cli`
- `../.logs/` — where `dev.sh` persists the tee'd log and `tail-host-log.sh` reads it from

### External
- `extensions-cli` (`@ableton-extensions/cli`) — runs/loads the extension into the Extension Host
- `tsx` — executes `build.ts` directly without a separate compile step

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
