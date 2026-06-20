# Max Build Checklist — the M4L FALLBACK path

> **Read `extension/README.md` first.** The recommended path is **SDK-only** — the SDK can set Serum's
> params directly (`Device.parameters` works for third-party plugins) and capture with
> `renderPreFxAudio`, so no Max for Live is needed. The real adapter (`src/liveAdapter.ts`) is already
> written and tested. Use **this** checklist only if Spike A shows the SDK can't reach Serum's params,
> in which case M4L `LiveAPI` provides `get/setCutoff` and the rest stays SDK-side.

This is the Ableton-dependent work for the fallback. It backs the `get/setCutoff` half of
`src/liveAdapter.ts` with `LiveAPI`. Order matters: each step is independently verifiable.

## Device shape

A **Max for Live Audio Effect** placed **after Serum** on the track:

```
Serum  →  [ our audio-effect device ]  →  rest of chain
```

It needs both worlds: the **audio** flowing through it (to record) and **LiveAPI** (to read/set Serum's param).
Audio Effect devices have a `plugin~ / plugout~` audio path *and* can host `live.object` / a Node-for-Max `js`.

## Step 1 — Prove the audio tap (go/no-go #1)

- [ ] Place the device after Serum. Route `plugin~` → `sfrecord~`.
- [ ] Play the one-note clip; toggle `sfrecord~` to write ~0.7 s to `cutoff_test.wav` in a known temp folder.
- [ ] Open the WAV — confirm it contains Serum's note, not silence.

**If this fails, stop** — capture is the riskiest assumption. Fallback: Extensions SDK `renderPreFxAudio`.

## Step 2 — Prove param control (go/no-go #2)

- [ ] Run the M0 dump (`../BUILD_PLAN.md` Milestone 0) to find Serum's **Filter Cutoff** parameter index.
- [ ] From a `live.object` / `js`, `set value` on that parameter and confirm the filter audibly moves.
- [ ] Read it back with `get value` and confirm round-trip.

Steps 1–2 together ARE the go/no-go from `../DEMO_PATH.md §8`.

## Step 3 — Wire the bridge

- [ ] Add a **Node for Max** (`node.script`) object; this is where `src/*.ts` runs.
- [ ] Back `LiveAdapter`'s `get/setCutoff` (`src/liveAdapter.ts`) with M4L instead of the SDK param:
  - `getCutoff()` / `setCutoff(v)` → message the Max patch, which does the `live.object` get/set.
  - `renderAndMeasure()` → trigger record, wait for `sfrecord~` done, load the WAV to Float32, call
    `spectralCentroid()` (already written, unchanged).
- [ ] WAV→Float32: a few lines of PCM parsing (16/24-bit) or any small wav reader.

## Step 4 — Wire the UI + loop

- [ ] A **"Brighter"** `button` → bang into Node for Max → `brighter(liveAdapter, {})` (engine unchanged).
- [ ] A text readout fed by the returned `log` / result: before→after cutoff and centroid.
- [ ] **Undo**: keep `result.snapshot`; a second button calls `setCutoff(snapshot)`.

## Step 5 — Definition of done (matches DEMO_PATH §4)

- [ ] Clicking Brighter audibly opens the filter.
- [ ] Readout shows centroid increased; loop stops itself (target or cap).
- [ ] Undo restores the original sound.
- [ ] Works on a real Serum patch in real Ableton.

## After it works

- The LLM path is the MCP server (`extension/ableton-sdk-mcp/`): Claude drives `apply_sound_intent`
  and reads APO deltas; the engine's `Proposer` seam (`src/intentEngine.ts`) takes non-deterministic
  brains too (seeded random "explore" today, LLM-proposed steps later).
- "Cutoff" is already generalized through the synth profile (`src/profiles.ts`) → any knob → richer
  intents ("more aggressive", "surprise me").

## Notes / gotchas

- **Param exposure:** if Filter Cutoff isn't in the dump, expose it via Live's **Configure Mode** — that's the
  curated-surface step, not a blocker.
- **Record timing:** give `sfrecord~` a fixed window (e.g. 0.7 s) and wait for completion before analyzing.
- **Latency:** plugin latency / tail means start recording a hair after note-on; trim the WAV head if needed.
- **Same sample rate:** pass Live's sample rate into `spectralCentroid` so frequencies are correct.
