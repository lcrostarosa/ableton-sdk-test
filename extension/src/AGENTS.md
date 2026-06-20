<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# src

## Purpose
The extension's single entry point. It implements `activate()` — the function the Ableton
Extensions SDK calls on load — registering two commands (`serumBrighter.brighter`,
`serumBrighter.revert`) plus a MIDI-track context-menu action. This is the *only* Live-specific
code in the project: it adapts the portable demo engine (`../../src/*.ts`, i.e. `ideas/demo/src/`)
to the real SDK.

## Key Files
| File | Description |
|------|-------------|
| `extension.ts` | `activate()`: locates the Serum-loaded track, runs the brighten loop inside a progress dialog, registers commands/context-menu actions, and implements snapshot-based undo |

## For AI Agents

### Working In This Directory
- Keep this file thin — it's host wiring, not engine logic. New brightening/measurement behavior
  belongs in `../../src/*.ts` (`engineLLM.ts`, `planners.ts`, `liveAdapter.ts`, …), not here.
- `findSerumTrack()` scans `track.devices` for a name containing "serum" (case-insensitive);
  `resolveSerumTrack(args)` prefers the right-clicked track's `Handle` (resolved via
  `context.getObjectFromHandle(handle, MidiTrack)`) and falls back to the scan.
- `REGION = { startBeat: 0, endBeat: 4 }` is hardcoded to match the one-note arrangement clip
  described in `../README.md §3` — it is not yet user-configurable.
- The mock planner (`makeMockPlanner({ step: 0.08 })`, line 69) is wired up by default. Swapping
  in `makeClaudePlanner` (the commented import on line 19) is the documented "go AI" step —
  see `../README.md §4`.
- Undo is snapshot-based, not transactional: `LiveAdapter.create(...).then(a =>
  a.setCutoff(lastResult.snapshot))`. The comment above `serumBrighter.revert` explains why —
  the SDK's `withinTransaction` can't wrap an async loop.

### Testing Requirements
- `npm run typecheck` from the project root (`tsc --noEmit`) is the only check runnable without
  a rig — it validates this file against the SDK's published types.
- Functional testing requires a live Ableton rig per `../README.md §0`: confirm the SDK can read
  and `setValue` Serum's parameters, and that `renderPreFxAudio` works on the (MIDI) Serum track.

### Common Patterns
- SDK surface used here: `initialize(activation, "1.0.0")` → `context`;
  `context.commands.registerCommand(name, handler)`;
  `context.ui.withinProgressDialog(title, initial, asyncFn)`;
  `context.ui.registerContextMenuAction(scope, label, command)`;
  `context.getObjectFromHandle(handle, MidiTrack)`.
- Imports of the portable engine use relative paths two levels up (`../../src/...`) — this
  assumes the extension folder sits at `ideas/demo/extension/`, per `../README.md §2`. Don't
  relocate `extension.ts` without updating these.

## Dependencies

### Internal
- `../../src/liveAdapter.ts` — `LiveAdapter`: render audio, read/set cutoff, snapshot/restore
- `../../src/engineLLM.ts` — `brighterWithPlanner`: the closed perception-action loop
- `../../src/planners.ts` — `makeMockPlanner` (active) and `makeClaudePlanner` (commented out)

### External
- `@ableton-extensions/sdk` — `initialize`, `MidiTrack`, and the `ActivationContext`/`Handle` types
- `node:fs` — passed into `LiveAdapter.create` for rendering/reading WAV files

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
