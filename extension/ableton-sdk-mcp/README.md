# ableton-sdk-mcp — the LLM control plane for Live

Claude Code (the L4 planner) ⇄ **stdio MCP server** ⇄ `ws://127.0.0.1:17890` ⇄ **kernel
extension** inside Live's Extension Host (the only place Live API calls happen) ⇄ the
portable sound-intent engine (`ideas/demo/src/*`) driving Serum through `LiveAdapter`.

"Make this synth brighter" typed in Claude Code becomes
`ableton_apply_sound_intent { recipeId: "brighter", intensity }`, runs a clamped, damped,
constraint-guarded convergence loop measured through the routed **AI Ear** audio track, and
returns before/after audio measurements plus a `revertToken`.

## Layout

- `kernel/` — Ableton Extensions SDK extension. Bundles the engine + a `ws` server.
  All Live API access lives here (`src/handlers.ts`); `src/extension.ts` is the bridge.
- `abletonsdk-mcp-server/` — the stdio MCP server Claude Code launches. Validates inputs
  (zod), proxies to the kernel, carries the recipe catalog in its tool descriptions.
  Never imports `@ableton-extensions/sdk`.

## Tools

| Tool | Class | What it does |
|---|---|---|
| `ableton_get_context` | read | Live Set overview: tracks, types, devices |
| `ableton_get_track` | read | One track's devices + parameter counts |
| `ableton_get_device` | read | Device parameters (bounded; `maxParams`, `includeValues`) |
| `ableton_render_audio` | read | Render an AudioTrack region → APO measurement |
| `ableton_list_sound_controls` | read | Registry vs exposed params; `missing` ⇒ Configure-Mode fix |
| `ableton_apply_sound_intent` | write (revertible) | Run a recipe: brighter, darker, moreBass, lessBass, aggressive, softer, wider, movement |
| `ableton_revert_sound_intent` | write | Restore the snapshot from an apply (`token` or last) |
| `ableton_run_code` | destructive | Escape hatch: JS in the extension host with `(song, resources, fs)` |

## Setup

```bash
npm run setup        # installs kernel + server deps
npm run build        # bundles the kernel extension to kernel/dist/extension.js
npm test             # offline MCP tests (stubbed bridge; no Live needed)
```

1. **Load the kernel in Live**: Preferences → Plug-Ins → Extensions → add the `kernel/`
   folder (entry `dist/extension.js`, manifest `abletonSdkMcpKernel`). The host log shows
   `bridge_listening {"url":"ws://127.0.0.1:17890"}`.
2. **Register the MCP server in Claude Code** (Node ≥ 23.6 runs the TS entry directly):

   ```bash
   claude mcp add ableton -- node /ABS/PATH/TO/ableton-sdk-mcp/abletonsdk-mcp-server/src/index.ts
   ```
3. **One-time Live Set setup** (see `../README.md` §0.5): Serum on a MIDI track with the
   curated params exposed via Configure Mode; an audio track named **AI Ear** with
   *Audio From = Serum track*, *Monitor = In*; a sustained one-note arrangement clip over
   beats 0–4.

## Rig QA checklist (evidence → `.sisyphus/evidence/`)

1. `ableton_get_context` lists the Serum track and the `AI Ear` track.
2. `ableton_list_sound_controls` resolves every registry control; deliberately un-expose one
   in Configure Mode → it appears under `missing` with the fix text.
3. Each closed-loop intent (brighter, darker, moreBass, lessBass, aggressive, softer) from
   chat → audible change, APO before/after moves the expected direction, sane stop `reason`;
   `ableton_revert_sound_intent` restores the knobs.
4. wider / movement → params move as reported in `deltas`.
5. Failure drills: no `AI Ear` track → instructive error, host stays alive; silent clip →
   near-zero `rms` in `beforeAPO` explains the non-result.
6. End-to-end script: "make this synth brighter", "now add more bass but keep it from
   getting muddy", "undo that" — all from chat, no code typed.

## Boundary rules (do not regress)

- MCP server: no stdout logging (stdout is the transport); diagnostics to stderr.
- Live API calls only in the kernel; the server validates, proxies, bounds output.
- `ableton_run_code` stays annotated destructive/open-world and is never the default path
  for sound workflows.
