// APO metrics against synthesized signals with KNOWN spectra. Pure Node, no rig.
//   node ideas/demo/measure.test.ts
import assert from "node:assert";
import { measureAPO } from "../src/common/measure.ts";
import { FakeSerum } from "./fixtures/audio/fakeSerum.ts";

let pass = 0;
function check(name: string, fn: () => unknown): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("  ✓ " + name);
      pass++;
    })
    .catch((e: unknown) => {
      console.log(
        "  ✗ " + name + " - " + (e instanceof Error ? e.message : String(e)),
      );
      process.exitCode = 1;
    });
}

const SR = 44100;
function sine(freq: number, seconds = 0.5): Float32Array {
  const n = Math.floor(SR * seconds);
  const buf = new Float32Array(n);
  const w = (2 * Math.PI * freq) / SR;
  for (let i = 0; i < n; i++) buf[i] = Math.sin(w * i);
  return buf;
}

console.log("bassRatio on known spectra:");

await check("a 60 Hz sine is essentially all bass energy", () => {
  const apo = measureAPO(sine(60), SR);
  assert(apo.bassRatio > 0.9, `bassRatio=${apo.bassRatio}`);
});

await check("a 2 kHz sine has essentially no bass energy", () => {
  const apo = measureAPO(sine(2000), SR);
  assert(apo.bassRatio < 0.05, `bassRatio=${apo.bassRatio}`);
});

await check(
  "mixing a sub under a bright tone raises bassRatio and nothing else dominates",
  () => {
    const bright = sine(2000);
    const mixed = new Float32Array(bright.length);
    const sub = sine(55);
    for (let i = 0; i < mixed.length; i++)
      mixed[i] = bright[i]! * 0.5 + sub[i]! * 0.5;
    const a = measureAPO(bright, SR);
    const b = measureAPO(mixed, SR);
    assert(
      b.bassRatio > a.bassRatio + 0.2,
      `bassRatio ${a.bassRatio} -> ${b.bassRatio}`,
    );
    assert(
      b.centroid < a.centroid,
      "adding a sub should pull the centroid down",
    );
  },
);

console.log("existing metrics stay sane:");

await check("centroid of a 2 kHz sine sits near 2 kHz; highRatio ~1", () => {
  const apo = measureAPO(sine(2000), SR);
  assert(Math.abs(apo.centroid - 2000) < 200, `centroid=${apo.centroid}`);
  assert(apo.highRatio > 0.9, `highRatio=${apo.highRatio}`);
});

await check("rms of a full-scale sine is ~0.707", () => {
  const apo = measureAPO(sine(440), SR);
  assert(Math.abs(apo.rms - Math.SQRT1_2) < 0.01, `rms=${apo.rms}`);
});

console.log("FakeSerum knobs move the metrics they claim to move:");

await check("raising subLevel raises bassRatio", () => {
  const synth = new FakeSerum({ durationSec: 0.3 });
  const before = measureAPO(synth.render(), synth.sampleRate);
  synth.setSubLevel(0.8);
  const after = measureAPO(synth.render(), synth.sampleRate);
  assert(
    after.bassRatio > before.bassRatio,
    `bassRatio ${before.bassRatio} -> ${after.bassRatio}`,
  );
});

await check("detune changes the render without silencing it", () => {
  const synth = new FakeSerum({ durationSec: 0.3 });
  const before = synth.render();
  synth.setDetune(0.5);
  const after = synth.render();
  let diff = 0;
  for (let i = 0; i < before.length; i++)
    diff += Math.abs(after[i]! - before[i]!);
  assert(diff > 1, "detune did not change the waveform");
  assert(
    measureAPO(after, synth.sampleRate).rms > 0.01,
    "detuned render went silent",
  );
});

await check(
  "the default patch render is unchanged by the new knobs at 0",
  () => {
    const a = new FakeSerum({ durationSec: 0.3 }).render();
    const b = new FakeSerum({ durationSec: 0.3 });
    b.setSubLevel(0);
    b.setDetune(0);
    b.setLfoRate(0);
    const bb = b.render();
    for (let i = 0; i < a.length; i += 997) {
      assert.strictEqual(bb[i], a[i], `sample ${i} differs`);
    }
  },
);

console.log(`\n${pass} checks passed`);
