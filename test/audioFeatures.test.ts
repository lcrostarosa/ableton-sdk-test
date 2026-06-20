import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAudioFeatures } from "../src/audioFeatures.ts";
import {
  PRESET_CORPUS_SCHEMA_VERSION,
  validatePresetRecord,
} from "../src/presetCorpus.ts";
import { encodeWavStereo } from "../src/wav.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");

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

function sine(freq: number, seconds = 2.5, amp = 0.8): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return out;
}

function padWithSilence(signal: Float32Array, leading = 0.15, trailing = 0.2): Float32Array {
  const lead = Math.floor(leading * SR);
  const tail = Math.floor(trailing * SR);
  const out = new Float32Array(lead + signal.length + tail);
  out.set(signal, lead);
  return out;
}

function mix(signals: Float32Array[]): Float32Array {
  const first = signals[0];
  if (!first) return new Float32Array(0);
  const out = new Float32Array(first.length);
  for (const signal of signals) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (signal[i] ?? 0);
  }
  return out;
}

console.log("audio feature extraction:");

await check("bright and bass-heavy fixtures produce schema-compatible feature vectors", () => {
  const bright = extractAudioFeatures({
    samples: padWithSilence(sine(2600, 2.0, 0.35)),
    sampleRate: SR,
  });
  const bassHeavy = extractAudioFeatures({
    samples: padWithSilence(mix([
      sine(55, 2.0, 0.65),
      sine(220, 2.0, 0.25),
      sine(1400, 2.0, 0.1),
    ])),
    sampleRate: SR,
  });

  assert((bright.centroid ?? 0) > (bassHeavy.centroid ?? 0), "bright centroid should be higher");
  assert((bright.highRatio ?? 0) > (bassHeavy.highRatio ?? 0), "bright highRatio should be higher");
  assert((bassHeavy.bassRatio ?? 0) > (bright.bassRatio ?? 0), "bass-heavy bassRatio should be higher");
  assert.strictEqual(bright.features?.protocolVelocity, 100);
  assert.strictEqual(bright.features?.protocolRenderLengthSeconds, 2.5);
  assert.strictEqual(bright.features?.analysisRepeatCount, 1);
  assert.strictEqual(bright.provenance?.[0]?.kind, "derived_from_audio");
  assert(bright.provenance?.[0]?.detail?.includes("midiNotes=C2,C3,C4"));
  assert((bright.features?.analysisDurationSeconds ?? 0) < (bright.durationSeconds ?? 0));

  const record = validatePresetRecord({
    schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
    id: "fixture.audio-features",
    file: {
      relativePath: "synthetic/fixture-audio.wav",
      fileName: "fixture-audio.wav",
    },
    source: { kind: "fixture" },
    audioFeatures: bright,
    provenance: [{ kind: "fixture", detail: "synthetic audio feature fixture" }],
  });

  assert.strictEqual(record.audioFeatures?.features?.protocolVelocity, 100);

  const stereoLeft = sine(2200, 2.0, 0.45);
  const stereoRight = mix([sine(110, 2.0, 0.65), sine(330, 2.0, 0.2)]);
  const wavPath = path.join(os.tmpdir(), `audio-features-${Date.now()}.wav`);
  fs.writeFileSync(wavPath, encodeWavStereo(stereoLeft, stereoRight, SR));

  const rigAverage = extractAudioFeatures([
    { wavPath },
    { wavPath },
    { wavPath },
  ], { mode: "rig" });

  assert.strictEqual(rigAverage.features?.analysisRepeatCount, 3);
  assert.strictEqual(rigAverage.features?.analysisMonoMixdownApplied, 1);
  assert(rigAverage.provenance?.[0]?.detail?.includes("mode=rig"));
  assert(rigAverage.provenance?.[0]?.detail?.includes("averagedRepeats=3"));

  fs.writeFileSync(
    path.join(evidenceDir, "task-6-audio-features.txt"),
    [
      `bright.centroid=${bright.centroid?.toFixed(2)}`,
      `bright.highRatio=${bright.highRatio?.toFixed(4)}`,
      `bassHeavy.centroid=${bassHeavy.centroid?.toFixed(2)}`,
      `bassHeavy.bassRatio=${bassHeavy.bassRatio?.toFixed(4)}`,
      `rigAverage.analysisRepeatCount=${rigAverage.features?.analysisRepeatCount}`,
      `rigAverage.analysisMonoMixdownApplied=${rigAverage.features?.analysisMonoMixdownApplied}`,
      `rigAverage.provenance=${rigAverage.provenance?.[0]?.detail}`,
    ].join("\n"),
  );
});

await check("silence produces only finite values and low-confidence evidence", () => {
  const silent = extractAudioFeatures({
    samples: new Float32Array(Math.floor(SR * 2.5)),
    sampleRate: SR,
  });

  assert.strictEqual(silent.centroid, 0);
  assert.strictEqual(silent.highRatio, 0);
  assert.strictEqual(silent.bassRatio, 0);
  assert.strictEqual(silent.rms, 0);
  for (const value of [
    silent.centroid,
    silent.highRatio,
    silent.bassRatio,
    silent.rms,
    ...Object.values(silent.features ?? {}),
  ]) {
    assert(Number.isFinite(value), `non-finite value ${value}`);
  }
  assert((silent.features?.analysisConfidence ?? 1) < 1, "silent confidence should be low");
  assert.strictEqual(silent.features?.analysisSilent, 1);
  assert.strictEqual(silent.features?.analysisSilentRepeatCount, 1);
  assert(silent.provenance?.[0]?.detail?.includes("silentRepeats=1"));

  fs.writeFileSync(
    path.join(evidenceDir, "task-6-silence.txt"),
    [
      `centroid=${silent.centroid}`,
      `highRatio=${silent.highRatio}`,
      `bassRatio=${silent.bassRatio}`,
      `rms=${silent.rms}`,
      `analysisConfidence=${silent.features?.analysisConfidence}`,
      `analysisSilent=${silent.features?.analysisSilent}`,
      `provenance=${silent.provenance?.[0]?.detail}`,
    ].join("\n"),
  );
});

console.log(`Passed ${pass} audio feature checks.`);
