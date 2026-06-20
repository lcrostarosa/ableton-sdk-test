# AI Sound-Design Demo

An AI-driven sound-design system for Ableton Live / Xfer Serum2. You tell it "make this bass
meaner, keep the sub clean" — it runs a closed-loop convergence loop inside Live, measures the
audio after each step, and stops when the target is hit (or a constraint is violated).

---

## What it does

The system drives synth parameters toward a semantic intent ("brighter", "more aggressive",
"wider") by:

1. Rendering the synth's output to a WAV file
2. Measuring an Audio Perception Object (APO) — spectral centroid, high-band ratio, bass-band ratio, RMS, loudness, stereo width, etc.
3. Pushing control values one step in the recipe's direction
4. Measuring again, checking constraints, and repeating until the target metric ratio is met

The LLM (Claude) is the **L4 planner** — it maps free text to a `{recipeId, intensity}` pair
using the recipe catalog embedded in the MCP tool descriptions, then reads the before/after APO
to decide whether to re-invoke or revert.

---

## System shape

```
Claude Code / Claude Desktop
        │  MCP stdio
        ▼
abletonsdk-mcp-server          ← Node process, runs outside Live
        │  WebSocket ws://127.0.0.1:17890
        ▼
kernel extension               ← runs inside Ableton Live's Extension Host
        │  Extensions SDK
        ▼
Ableton Live
  ├── Synth track (Serum)      ← parameter control plane
  └── "AI Ear" audio track     ← audio capture plane (routed from synth)
```

Two planes, never mixed:
- **Control plane** — JSON over WebSocket (recipe calls, APO results, parameter deltas)
- **Data plane** — WAV files on disk; paths are passed, not bytes

---

## Core concepts

**Closed-loop convergence**
The engine doesn't push a fixed amount and hope for the best. It renders audio, measures a
target metric (e.g. spectral centroid for brightness), steps the controls, measures again, and
repeats until the ratio between the new measurement and the baseline crosses the target. Each
iteration is a full render → measure → decide cycle.

**Recipe-as-data**
A sound-design intent ("brighter", "aggressive") is encoded as a plain data record: which
controls to move, in which direction, by how much per step, which audio metric to converge on,
what ratio to target, and which constraints must not be violated. The engine is generic; the
knowledge lives in the recipe. Adding a new intent means adding a row to `recipes.ts`, not
touching the loop.

**Proposer seam**
The engine doesn't decide *how* to move controls — it delegates that to a `Proposer` function.
The default is a deterministic stepper (move each control by `step × intensity` in its
direction). Swap it for the seeded random-walk proposer (`explore` recipe) or for an LLM
proposer without changing the loop at all.

**RecipeAdapter seam**
The engine doesn't know about Ableton, Serum, or WAV files. It calls three methods:
`get(id)` / `set(id, n)` / `measure()`. `LiveAdapter` implements these against the Extensions
SDK; tests use a fake double. Porting to a different DAW or synth means writing a new adapter,
not touching the engine.

**Audio Perception Object (APO)**
Every measurement the engine uses is a `ScalarAPO` — ten named numbers that describe a sound
perceptually: brightness, bass weight, loudness, transient punch, movement, and stereo
characteristics. Recipes target one of these numbers. The LLM reads before/after APOs to judge
whether the result matched the intent.

**Safe ranges and damping**
All control values are clamped to the synth profile's safe ranges before being written to the
device, so the engine cannot accidentally send a parameter to an extreme that destroys the
sound. If a step moves the target metric in the *wrong* direction (the metric got darker when
the recipe wanted brighter), the step size is halved — damping prevents oscillation on
non-monotonic responses.

**Constraint guarding**
A recipe can carry hard constraints: `{ metric: "rms", maxRatio: 3.0 }` means "stop and
revert the last step if RMS ever exceeds 3× its pre-edit value". Constraints fire before the
convergence check, so a loudness explosion from the `aggressive` recipe is caught and undone
immediately rather than accumulating.

**LLM as L4 planner**
Claude sits above the loop. It reads the recipe catalog embedded in the MCP tool description,
maps the user's free text to `{ recipeId, intensity }`, invokes `apply_sound_intent`, then
reads the returned before/after APO to decide whether to re-invoke with a different intensity,
chain a second recipe, or revert. The convergence loop itself never touches the LLM.

**revertToken**
Every `apply_sound_intent` call snapshots the pre-edit control values and stores them under a
token (up to 32 entries in a rolling log). Saying "undo that" calls `revert_sound_intent` with
that token and the synth is restored exactly, frame-accurate.

---

## Core components

| Component | Where | What it owns |
|-----------|-------|-------------|
| **Convergence engine** | `src/intentEngine.ts` | The `applyRecipe` loop: propose → clamp → set → measure → check constraints → damp → repeat. Generic; no DAW code. |
| **Recipe catalog** | `src/recipes.ts` | Nine named intents as data records. Also `matchIntent()` for keyword-to-recipe routing. |
| **Audio Perception Object** | `src/measure.ts` | `measureScalar()` for the loop; `measureFull()` adds a spectrogram for terminal renders. BS.1770 loudness, stereo metrics, spectral flux. |
| **Synth profile** | `src/profiles.ts` + `src/registry.ts` | Maps friendly control IDs (`filter.cutoff`) to device-parameter regex matchers and safe ranges. One profile per synth; engine is profile-agnostic. |
| **Proposer** | `src/proposers.ts` | Pluggable strategy for choosing next control values. Ships with deterministic stepper (built into engine) and seeded random-walk (mulberry32 PRNG). |
| **LiveAdapter** | `src/liveAdapter.ts` | `RecipeAdapter` backed by the Extensions SDK. Resolves controls lazily via the synth profile, renders via the "AI Ear" track, decodes WAV to Float32. |
| **Kernel extension** | `extension/ableton-sdk-mcp/kernel/` | Runs inside Live's Extension Host. WebSocket server on port 17890. All Extensions SDK calls live here. Dispatches to eight handlers; every async body is caught so an uncaught rejection cannot crash the host. |
| **MCP server** | `extension/ableton-sdk-mcp/abletonsdk-mcp-server/` | stdio MCP process managed by Claude Code. Registers 7 typed tools, embeds the recipe catalog in tool descriptions, proxies calls to the kernel over WebSocket. |
| **Preset corpus** | `src/presetCorpus.ts` + `src/presetLabels.ts` + `src/presetSimilarity.ts` | Offline pipeline: reads Serum preset files, derives trait/role labels from audio features and filename tokens, scores similarity with weighted multi-component scoring. Separate from the real-time engine. |

---


## Build and install

### Prerequisites

- Node ≥ 23.6 (MCP server requires it; kernel requires ≥ 22.11)
- Ableton Live with the Extensions SDK beta installed
- Claude Code CLI (`npm i -g @anthropic-ai/claude-code`)

---

### Step 1 — Install dependencies and build the kernel

```bash
# From the ableton-sdk-mcp workspace root — installs both packages at once
cd extension/ableton-sdk-mcp
ABLETON_EXTENSION_HOME=PATH_TO/extension/abletonsdk-mcp-server/ # set as env var if you want or todo makefile
vim .env # add `EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app` if not present or alter if needed 
cp .env ./extension/ableton-sdk-mcp/kernel/.env
npm run setup   # npm install in kernel/ and abletonsdk-mcp-server/
npm run build   # compiles kernel/src → kernel/dist/extension.js
```

---

### Step 2 — New Terminal Load the kernel extension into Ableton Live
```bash
cd extension/ableton-sdk-mcp/kernel
npm run bridge     # tsx build.ts && extensions-cli run
```
`extensions-cli run` registers the extension with Live and streams its logs. Keep this terminal open while you work.

---

### Step 3 — Register the MCP server with Claude Code

The MCP server runs as a stdio child process managed by Claude Code — you never start it manually.

```bash
claude mcp add -s project ableton-sdk-mcp -- node ${ABLETON_EXTENSION_HOME}/src/index.ts
```

Verify it registered:
```bash
claude mcp list
# ableton-sdk-mcp   stdio   node .../abletonsdk-mcp-server/src/index.ts
```

---

### Step 4 — Set up the "AI Ear" audio track (one-time, per Live Set)

Closed-loop recipes render audio via `renderPreFxAudio`, which only works on AudioTracks. Your
synth lives on a MIDI/Instrument track, so you need a permanent routing helper:

1. Create a new **Audio Track** in your Live Set
2. Name it exactly **`AI Ear`** (case-sensitive)
3. Set its **Audio From** input to the synth's track
4. Set **Monitor** to **In**

The `LiveAdapter` resolves this track by name on every `apply_sound_intent` call. If it's
missing, the tool returns setup instructions instead of running.


---

### Prompting Claude

Claude reads the recipe catalog from the `ableton_apply_sound_intent` tool description and maps
your words to a `{recipeId, intensity}` pair. You do not need to name recipes explicitly.

**Basic intents:**
```
Make this bass brighter, but subtle.
→ recipe: brighter, intensity: 0.3

Way more aggressive — I want bite and drive.
→ recipe: aggressive, intensity: 1.0

Dial back the bass a bit.
→ recipe: lessBass, intensity: 0.5

Widen it out.
→ recipe: wider, intensity: 0.7
```

**Constraints in plain English:**
```
Make it more aggressive but don't let the loudness blow up.
→ aggressive recipe; constraint guard (rms maxRatio: 3.0) auto-enforces this
```

**Undo:**
```
Revert that last change.
→ calls ableton_revert_sound_intent with the most recent revertToken
```

**Exploration:**
```
Surprise me — try something random.
→ recipe: explore (seeded random walk); re-invoking with the returned seed replays the exact same variation
```

**Before the first apply on a new set**, ask Claude to run an exposure check:
```
List the sound controls for track 2.
→ ableton_list_sound_controls — shows which Serum params resolved and which need Configure Mode
```

---

## How `applyRecipe` works

```
applyRecipe(adapter, recipe, opts)
  │
  ├─ snapshot all controls → enables revert()
  │
  ├─ [open-loop: no metric]
  │   proposer(state) → proposal
  │   clamp to safe ranges
  │   adapter.set() each control
  │   return { reason: "applied-open-loop", deltas, ... }
  │
  └─ [closed-loop: has metric + targetRatio]
      adapter.measure() → beforeAPO
      │
      loop (up to maxIters):
        proposer(state) → proposal
        clamp proposal to safe ranges
        if nothing moved → "hit-safe-limit", stop
        adapter.set() each control
        adapter.measure() → APO
        if constraint violated → revert this step, "constraint-blocked:<metric>", stop
        if metric crossed target → "target-met", stop
        else: damp steps if metric moved wrong way, continue
      │
      adapter.measure() → afterAPO
      return { before, after, ratio, reason, deltas, log, revert() }
```

**Constraint guard**: a constraint like `{ metric: "rms", maxRatio: 3.0 }` reverts the current
step and stops if RMS exceeds 3× its pre-edit value, preventing uncontrolled loudness from the
`aggressive` recipe.

**Damping**: the recipe stepper halves step sizes whenever the metric moved in the wrong
direction — prevents oscillation on non-monotonic responses.

**Stereo guard**: recipes targeting stereo metrics (`stereoWidth`, `correlation`,
`corrBelow120`) early-exit with `"mono-render-no-stereo-metric"` if the render is mono, rather
than spinning to max iterations.

---

## The "AI Ear" track requirement

`renderPreFxAudio` is AudioTrack-only (Spike B). The synth lives on a MIDI/Instrument track;
calling `renderPreFxAudio` on it rejects with a bare `undefined`. The fix is a permanent
one-time routing setup:

1. Create an audio track in Live, name it **"AI Ear"**
2. Set its **Audio From** to the synth's track
3. Set **Monitor** to **In**

`LiveAdapter.create` resolves the ear track by name from the Song. If it is missing,
`aiEarSetupError` throws an actionable message with these three steps.

---

## Recipe catalog

| Recipe | Metric | Target | Controls moved |
|--------|--------|--------|----------------|
| `brighter` | centroid | ×1.25 | filter.cutoff+ |
| `darker` | centroid | ×0.8 | filter.cutoff− |
| `moreBass` | bassRatio | ×1.4 | sub.level+, filter.cutoff− |
| `lessBass` | bassRatio | ×0.7 | sub.level−, filter.cutoff+ |
| `aggressive` | highRatio | ×1.6 | fx.drive+, filter.reso+, filter.cutoff+ |
| `softer` | highRatio | ×0.65 | fx.drive−, filter.reso− |
| `wider` | stereoWidth | ×1.3 | osc.detune+ |
| `movement` | flux | ×1.4 | lfo1.rate+ |
| `explore` | *(open-loop)* | — | all controls, seeded random walk |

All control values are normalized 0..1 and clamped to the profile's safe ranges before being
written to the device.

---

## Synth profile (Serum)

Controls are resolved by case-insensitive regex match against whatever parameter names Serum
exposes via Configure Mode. Safe ranges prevent musically extreme values:

| ID | Label | Safe range | Matcher |
|----|-------|-----------|---------|
| `filter.cutoff` | Filter Cutoff | 0.12–0.88 | `/(filter\s*)?cut\s*off/i` |
| `filter.reso` | Filter Resonance | 0.0–0.70 | `/res(o\|onance)?\b/i` |
| `fx.drive` | Drive | 0.0–0.85 | `/(drive\|dist(ortion)?)/i` |
| `sub.level` | Sub Oscillator Level | 0.0–0.95 | `/sub.*(level\|vol)/i` |
| `osc.detune` | Unison Detune | 0.0–0.60 | `/(uni(son)?\s*)?det(une)?\b/i` |
| `lfo1.rate` | LFO 1 Rate | 0.05–0.90 | `/lfo\s*1?\s*rate/i` |

Supporting a new synth = adding a new `SynthProfile` in `profiles.ts`. No engine code changes.

---

## Packages

### `src/` — the portable engine (runs anywhere)

| File | Responsibility |
|------|---------------|
| `intentEngine.ts` | Generic convergence loop: propose → clamp → set → measure → check constraints → repeat. Proposer is a swappable seam. |
| `recipes.ts` | Recipe catalog as data (brighter / darker / moreBass / lessBass / aggressive / softer / wider / movement / explore). Each recipe names a metric, target ratio, controls with direction+step, and constraints. Also `matchIntent()` for keyword routing. |
| `measure.ts` | Audio Perception Object: `measureScalar()` for the convergence loop (centroid, highRatio, bassRatio, rms, crest, loudnessLufs, flux, stereoWidth, correlation, corrBelow120); `measureFull()` adds a coarse spectrogram grid at perception endpoints only. |
| `liveAdapter.ts` | `RecipeAdapter` backed by the Extensions SDK. `get`/`set` normalize parameters 0..1; `measure()` renders to WAV via the "AI Ear" audio track, decodes it, and returns a ScalarAPO. Controls resolve lazily against the synth profile's matchers. |
| `registry.ts` | `SynthProfile` type + helpers. Maps friendly control IDs (`filter.cutoff`) to device-parameter name matchers and safe operating ranges. |
| `profiles.ts` | Serum profile: 6 controls (filter.cutoff, filter.reso, fx.drive, sub.level, osc.detune, lfo1.rate) with regex matchers, safe ranges, default region, and metric band edges. |
| `proposers.ts` | Seeded random proposers (mulberry32 PRNG). `walk` mode jitters each control around its current value; `jump` mode samples uniformly inside the safe range. Same safety harness as the deterministic stepper. |
| `wav.ts` | WAV decoder (PCM → Float32Array + channelData). |
| `centroid.ts` | In-place Cooley-Tukey FFT. |
| `spectrogram.ts` | STFT, spectral flux, coarse time×frequency grid. |

**Preset corpus** (offline classification pipeline, separate from the real-time engine):

| File | Responsibility |
|------|---------------|
| `presetCorpus.ts` | Schema + runtime validator for `PresetCorpus` / `PresetRecord`. A record carries file metadata, source provenance, parameter snapshots, audio features, trait/role labels, and similarity results. |
| `presetLabels.ts` | Derives trait labels (brightness, bass_weight, intensity, movement, noisiness, articulation) and role labels (bass, lead, pad, pluck, keys, fx, arp, atmosphere, percussion) from filename tokens, audio features, and parameter snapshots. Multi-source confidence is combined probabilistically. |
| `presetSimilarity.ts` | Weighted multi-component similarity: audio 56%, parameters 24%, traits 10%, roles 6%, metadata 4%. Builds per-corpus feature ranges for normalization. |
| `presetCorpusStore.ts` | Corpus persistence (JSON on disk). |
| `filePresetSource.ts` | Reads `.SerumPreset` files from disk into corpus records. |
| `livePresetSource.ts` | Reads preset data from the live Ableton session. |
| `acquisitionGates.ts` | Guards for whether each data source is available. |

---

### `extension/ableton-sdk-mcp/` — the MCP bridge

**`kernel/`** — Extensions SDK extension, runs inside Ableton Live

- `extension.ts` — `activate()` starts a WebSocket server on `ws://127.0.0.1:17890`. Each
  incoming JSON message is dispatched to a handler. Every async body is caught so an uncaught
  rejection cannot kill the Extension Host.
- `handlers.ts` — All Live API access lives here. Seven methods:
  - `get_context` — Live Set overview (tracks, devices, tempo, synth profiles)
  - `get_track` — track detail with device list
  - `get_device` — exposed parameters (Configure Mode required for VST params)
  - `render_audio` — renders the "AI Ear" track, returns full APO + spectrogram
  - `list_sound_controls` — exposure check: which profile controls are found/missing with Configure-Mode instructions
  - `apply_sound_intent` — runs `applyRecipe(LiveAdapter, recipe, opts)`, stores a revert snapshot, returns before/after APO, deltas, stop reason, and a `revertToken`
  - `revert_sound_intent` — restores the pre-edit snapshot by token (or latest)
  - `run_code` — escape hatch: evaluates JS with `(song, resources, fs)` in scope
- `protocol.ts` — `BridgeRequest` / `BridgeResponse` shapes

**`abletonsdk-mcp-server/`** — stdio MCP server, run by Claude Code

- `index.ts` — Creates an `McpServer` with 7 tools. The recipe catalog is embedded verbatim in
  `ableton_apply_sound_intent`'s description so Claude can pick recipes without a round-trip.
  Every tool call is proxied to `KernelClient.call()`.
- `kernel-client.ts` — WebSocket client to `ws://127.0.0.1:17890`. Lazy-connects, matches
  responses to requests by ID, times out hung calls (120 s default).
- `schemas.ts` — Zod schemas for all tool parameters.

---

### `extension/src/` — in-Live context-menu commands

- `extension.ts` — SDK entry point; registers sound intent commands and menus.
- `soundIntents.ts` — Context-menu commands on MIDI tracks that call `applyRecipe` through the
  same engine the MCP tools use — identical code path, different entry point.

---

## Running the tests

```bash
npm test
```

Tests in `test/` exercise the engine, adapters, and the preset corpus pipeline against fixtures
and deterministic doubles. Live is not required — `test/fixtures/` provides fake SDK rigs.
