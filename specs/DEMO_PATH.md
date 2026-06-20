# Demo Path — The Smallest Thing That Visibly Works

**Status:** idea / execution — the first demo
**Goal:** prove the core magic — *change a Serum param → render → measure → adjust → stop* — in the
fewest possible moving parts. **No separate app, no Extensions SDK, no Claude yet.**

---

## 0. The one scenario

> Producer has a Serum bass on a track. They click a **"Brighter"** button. The filter audibly opens, and the
> device reports *"centroid 1850 Hz → 2400 Hz (+30%), cutoff 0.42 → 0.61."* Undo restores the original.

That's the whole demo. It proves the closed loop works on **one request, one param, one render, one metric.**

The "intelligence" is hardcoded (brighter = raise cutoff until the measured brightness rises). Claude is a
**one-function swap** added *after* this works (§6).

---

## 1. Radically minimal stack — ONE device

Everything lives inside a single **Max for Live Audio Effect** placed **right after Serum** on the track:

```
Serum  →  [ Our M4L device ]  →  (rest of chain)
             ├─ taps Serum's audio output (it's downstream)
             ├─ reads/sets Serum's Filter Cutoff via LiveAPI
             ├─ records the audio to a WAV (sfrecord~)
             └─ Node for Max: runs the loop, measures centroid (Meyda), decides next move
```

Why this is the minimal choice:
- **Audio capture is the hard part** of any demo. Placing our device *after* Serum means Serum's sound flows
  straight through it — we record it with `sfrecord~`, no Extensions SDK render needed.
- **Param control** uses the same `LiveAPI` path as the M0 dump spike — Filter Cutoff is one of Serum's
  default automatable params, so no Configure Mode needed for this one knob.
- **Node for Max** is plain Node.js, so `meyda` + a WAV decoder run inside the device. No external service.

---

## 2. Fixed setup (the demo rig)

1. A track with **Serum** (device 0), loaded with any bass patch where the filter isn't already wide open.
2. **Our M4L device** as device 1 (audio effect, after Serum).
3. A **one-note MIDI clip** in a session slot on that track — e.g. C1, 2 beats.
4. The device has: a **Brighter** button, a **readout** (centroid + cutoff before/after), and an **Undo** note.

---

## 3. The loop (hardcoded, no AI)

```
click "Brighter"
  │
  ├─ read cutoff_0 via LiveAPI            (e.g. 0.42)
  ├─ render(): fire the clip, sfrecord~ N seconds -> take0.wav, stop
  ├─ centroid_0 = meyda(take0.wav)        (e.g. 1850 Hz)   ← BEFORE
  │
  ├─ loop up to 4 times:
  │     cutoff += step (e.g. +0.08, clamped to safe_range [0.12, 0.88])
  │     set cutoff via LiveAPI
  │     render() -> take_i.wav
  │     centroid_i = meyda(take_i.wav)
  │     if centroid_i >= centroid_0 * 1.25:  break      ← target: +25% brightness
  │     if centroid_i <= centroid_(i-1):     step *= 0.5 (damping)
  │
  └─ report: cutoff_0 -> cutoff_final, centroid_0 -> centroid_final
     keep a snapshot of cutoff_0 so Undo restores it
```

Five things only: **read → render → measure → step → stop.** This is the convergence engine in miniature.

---

## 4. Definition of done (what "it works" means)

- Clicking **Brighter** **audibly** opens the filter.
- The readout shows centroid **increased** and reports the cutoff change.
- The loop **stops** on its own (hits target or iteration cap) — it does not run away or oscillate.
- **Undo** restores the original cutoff (and original sound).
- Runs on a real Serum patch in real Ableton.

If all five hold, the core product mechanic is **proven**. Everything else (more params, recipes,
constraints, the LLM, the perception richness) is *additive* on top of this exact loop.

---

## 5. Explicitly cut from the demo (do NOT build yet)

- ❌ Claude / any LLM (hardcoded rule stands in)
- ❌ The separate orchestrator app / WebSocket (all in-device)
- ❌ Extensions SDK / capture-to-Simpler
- ❌ Recipes, constraints, the full registry (one param, hardcoded safe_range)
- ❌ Full Audio Perception Object (one metric: spectral centroid)
- ❌ JUCE / offline rendering
- ❌ Multiple params, sub-cleanliness, mixing, MIDI generation

Each of these is a later milestone; none is needed to see the loop work.

---

## 6. The two upgrades right after the demo (each tiny)

1. **Add Claude (makes it "AI"):** replace the hardcoded `cutoff += step` decision with a single call —
   give Claude `{request:"brighter", registry, centroid_before, centroid_now}` and let it return the next op
   (`set_knob("FILTER","Cutoff", x)`). Same loop, same render, same metric. One function swapped.
2. **Add a second param + the registry:** generalize "Cutoff" into the registry resolver so the same loop can
   move any knob. Now "more aggressive" (drive + reso) becomes reachable.

After those two, you're standing inside the real architecture — the demo *was* the walking skeleton.

---

## 7. Build order for the demo (concrete)

1. **M4L audio-effect device** after Serum; confirm it taps Serum's audio (meter shows signal on note).
2. **LiveAPI get/set** of Serum Filter Cutoff from the device (reuse the M0 dump approach to find its index).
3. **Render()**: trigger the session clip, `sfrecord~` a fixed window to a WAV in a temp folder, stop.
4. **Measure**: Node for Max loads the WAV, `meyda` → spectral centroid. Print it.
5. **Loop + clamp + damping + Undo snapshot** (§3).
6. **Readout UI**: before/after centroid + cutoff.

Step 1–2 carry all the integration risk (audio tap + param exposure). If those two work, the rest is plumbing.

---

## 8. The one risk to retire first

Before wiring the loop, confirm in isolation:
- the device **records Serum's audio** to a WAV while the note plays, **and**
- it can **set Filter Cutoff** via LiveAPI and the change is audible.

That mini-check (a morning's work) is the real go/no-go. The loop around it is straightforward.
```
