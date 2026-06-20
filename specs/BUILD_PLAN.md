# Build Plan — How We Actually Start

**Status:** idea / execution plan
**Strategy:** walking skeleton, **risk-first**. Prove the riskiest link before building anything fancy.

---

## 0. The principle

Do **not** build the architecture top-down. Build the **thinnest end-to-end thread** and front-load the
**highest-uncertainty** piece. For this project the risk ranking is:

1. 🔴 **Can we read/set Serum's params from outside Live, and which are exposed?**  ← unknown, blocking
2. 🟠 Can we audition (trigger a note) and capture a render to disk?  ← mostly known (SDK `renderPreFxAudio`)
3. 🟡 Can we analyze audio into a mini-APO?  ← known (Meyda, pure Node)
4. 🟢 Can an LLM emit ops over a registry?  ← well understood

So we build in that order. The LLM comes **last**, not first.

---

## Milestone 0 — Serum parameter dump (the make-or-break spike)

**Goal:** get the ground-truth list of Serum's automatable parameters as Live sees them. This single output
seeds the registry, the curated surface, and tells us whether the whole approach is viable.

**Do it in Max (no orchestrator yet).** Drop a `js` object in an M4L device on a track that has Serum loaded,
and run:

```js
// dumpparams.js  — Max 'js' object. Select the Serum track, send this a bang.
// Assumes Serum is the first device on the selected track (devices 0).
function bang() {
    var base = "live_set view selected_track devices 0";
    var dev = new LiveAPI(null, base);
    var n = dev.getcount("parameters");
    post("Serum exposes " + n + " parameters\n");
    for (var i = 0; i < n; i++) {
        var p = new LiveAPI(null, base + " parameters " + i);
        post(i + ": '" + p.get("name") + "'"
             + "  min=" + p.get("min")
             + "  max=" + p.get("max")
             + "  val=" + p.get("value") + "\n");
    }
}

// to set one (test that control works): assign and listen
function setparam(index, value) {
    var p = new LiveAPI(null, "live_set view selected_track devices 0 parameters " + index);
    p.set("value", value);
    post("set param " + index + " (" + p.get("name") + ") -> " + value + "\n");
}
```

**Definition of done:**
- A printed list of Serum's exposed parameter names + ranges.
- Confirmation we can **set** one (e.g. assign `p.set("value", x)` on Filter Cutoff and hear/see it move).
- A note on whether key targets (cutoff, reso, drive, warp, macros, LFO depths) are present **or** need
  **Configure Mode** to expose them.

**This determines the project.** If only macros are exposed → we lean hard on the 4-macro surface + preset
templates. If a rich set is exposed → the full registry is viable. Either way we now build from fact, not hope.

---

## Milestone 1 — Registry + remote set (control plane is born)

- Hand-write `registry.json` from the M0 dump (start with ~8 params, not 30).
- M4L device runs **Node for Max**, opens a **WebSocket** to a local Node orchestrator.
- Orchestrator exposes one verb: `set_knob(module, knob, value)` → registry resolves → WS → `LiveAPI.set`.
- Add `safe_range` clamping in the registry resolver.

**DoD:** from a Node script, `set_knob("FILTER","Cutoff",0.3)` audibly moves Serum. Clamping verified.

---

## Milestone 2 — Audition + capture

- Place a short MIDI clip (one note) on the Serum track (manual is fine for now).
- Trigger playback over the region and capture audio with the **Extensions SDK** `resources.renderPreFxAudio(track, startBeat, endBeat)` → WAV path. (We already confirmed this API exists.)
- Alternatively stub with a pre-rendered WAV to unblock M3 in parallel.

**DoD:** a WAV file on disk that reflects the current Serum patch for a fixed test note.

---

## Milestone 3 — Mini perception (pure Node, fully testable)

- Node + **Meyda**: compute a tiny **Audio Perception Object** subset — RMS, spectral centroid, 4 band
  energies, crest factor. Output the APO JSON.
- This milestone needs **no Live/Serum** — test it on any WAV. Build it in parallel with M0–M2.

**DoD:** `analyze(wavPath) -> APO` returns sane numbers on known test tones (sine = low centroid, noise = high).

---

## Milestone 4 — Hardcoded closed loop (NO LLM yet)

- Wire M1+M2+M3 into the **Convergence Controller** with a single hardcoded rule:
  *"make brighter" = raise Filter Cutoff until spectral centroid rises by N%, with iteration cap + damping.*
- Prove loop mechanics: set → render → measure → adjust → stop. Add `checkpoint()` / `revert()`.

**DoD:** running "brighter" converges in ≤4 iterations and stops; "revert" restores the original patch.
This proves the **engine** before any AI is involved — the part most likely to oscillate or run away.

---

## Milestone 5 — Add the LLM (one recipe, one constraint)

- Anthropic SDK. Give Claude: the registry (friendly names), the current APO, and **one** recipe
  (`aggression`) + **one** constraint (`clean_sub`).
- Claude emits L2/L3 ops; orchestrator executes through the proven M1–M4 thread.

**DoD:** "make this more aggressive, keep the sub clean" runs the full loop and produces an explained
before/after. Now the skeleton is end-to-end and every later feature is additive.

---

## Repo skeleton

```
/orchestrator            # Node/TS local service — the brain
  /registry              # registry.json + resolver (name -> backend, clamp, curves)
  /effectors             # m4l-adapter (WS), sdk-adapter (capture), juce-adapter (later)
  /perception            # Meyda mini-APO now; python sidecar later
  /engine                # convergence controller, checkpoints, op log
  /recipes               # aggression.json, animation.json, clean_sub.json
  /llm                   # Claude planner adapter
  protocol.ts            # control-plane message shapes (shared contract)
/max                     # M4L device: Node-for-Max bridge + dumpparams spike
/extension               # Ableton Extensions SDK: capture command + UI (created via ableton-create-extension)
/test-assets             # WAVs for offline perception tests
```

---

## Tech stack (first pass)

| Concern | Choice | Why |
|--------|--------|-----|
| Orchestrator | Node + TypeScript | shared types with SDK + Node for Max |
| Live param control | **Max for Live + Node for Max**, `LiveAPI` | only reliable way to reach Serum params |
| Control transport | WebSocket (localhost) | bidirectional, simple, JSON |
| Capture/render | Extensions SDK `renderPreFxAudio` | already available; JUCE later for speed |
| Perception (v1) | **Meyda** (Node) | in-process, zero Python setup to start |
| Perception (v2) | Python sidecar: librosa / pyloudnorm | full LUFS/MIR when needed |
| LLM | Anthropic SDK (Claude) | planner at L3/L2 |
| Data plane | files in temp dir | never serialize audio to the LLM |

---

## What's testable without Live vs what needs the rig

| Build now, pure Node (CI-able) | Needs Live + Serum + Max |
|--------------------------------|--------------------------|
| registry + resolver + clamping | M0 param dump |
| protocol message shapes | M1 remote `set_knob` round-trip |
| Meyda mini-APO (M3) | M2 audition/render |
| convergence controller logic (M4) on stubbed render | end-to-end M5 |
| recipe/constraint data + validation | — |

Build the left column in parallel immediately; gate the right column on Milestone 0's result.

---

## First action

**Run Milestone 0.** Everything else is sequenced behind knowing Serum's real exposed-parameter surface.
While that's happening, the orchestrator skeleton + registry resolver + Meyda mini-APO can be built and
unit-tested with zero dependence on Live.
```
