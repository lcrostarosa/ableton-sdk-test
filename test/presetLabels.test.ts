import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAudioFeatures } from "../src/common/audioFeatures.ts";
import { derivePresetLabels } from "../src/common/presetLabels.ts";
import {
  PRESET_CORPUS_SCHEMA_VERSION,
  type PresetRecord,
  validatePresetRecord,
} from "../src/common/presetCorpus.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");
const SR = 44100;

let pass = 0;

function check(name: string, fn: () => unknown): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("  ✓ " + name);
      pass++;
    })
    .catch((error: unknown) => {
      console.log(
        "  ✗ " +
          name +
          " - " +
          (error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
    });
}

function sine(freq: number, seconds = 2.5, amp = 0.8): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function square(freq: number, seconds = 2.5, amp = 0.8): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const phase = (freq * i) / SR;
    out[i] = Math.sin(2 * Math.PI * phase) >= 0 ? amp : -amp;
  }
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

function padWithSilence(signal: Float32Array, leading = 0.12, trailing = 0.18): Float32Array {
  const lead = Math.floor(leading * SR);
  const tail = Math.floor(trailing * SR);
  const out = new Float32Array(lead + signal.length + tail);
  out.set(signal, lead);
  return out;
}

function makeRecord(overrides: Partial<PresetRecord>): PresetRecord {
  return validatePresetRecord({
    schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
    id: "fixture.preset-labels",
    file: {
      relativePath: "Lead/LD Neon Atlas.SerumPreset",
      fileName: "LD Neon Atlas.SerumPreset",
      extension: ".SerumPreset",
    },
    source: { kind: "fixture" },
    provenance: [{ kind: "fixture", detail: "synthetic preset label fixture" }],
    ...overrides,
  });
}

console.log("preset label derivation:");

fs.mkdirSync(evidenceDir, { recursive: true });

await check("derives bright, bass-heavy, and aggressive labels from audio fixtures", () => {
  const brightAudio = extractAudioFeatures({
    samples: padWithSilence(sine(2600, 2.0, 0.38)),
    sampleRate: SR,
  });
  const bassAggressiveAudio = extractAudioFeatures({
    samples: padWithSilence(mix([
      sine(55, 2.0, 0.8),
      sine(110, 2.0, 0.35),
      square(1760, 2.0, 0.3),
    ])),
    sampleRate: SR,
  });

  const brightRecord = derivePresetLabels(makeRecord({
    id: "fixture.audio-bright",
    file: {
      relativePath: "Lead/LD Air Flash.SerumPreset",
      fileName: "LD Air Flash.SerumPreset",
      extension: ".SerumPreset",
    },
    audioFeatures: brightAudio,
  }));
  const bassAggressiveRecord = derivePresetLabels(makeRecord({
    id: "fixture.audio-bass-aggressive",
    file: {
      relativePath: "Bass/BR Iron Weight.SerumPreset",
      fileName: "BR Iron Weight.SerumPreset",
      extension: ".SerumPreset",
    },
    audioFeatures: bassAggressiveAudio,
  }));

  const brightTrait = brightRecord.traitLabels?.find((label) => label.trait === "brightness");
  assert(brightTrait);
  assert.strictEqual(brightTrait?.value, "bright");
  assert(brightTrait?.provenance.some((entry) => entry.kind === "derived_from_audio"));

  const bassTrait = bassAggressiveRecord.traitLabels?.find((label) => label.trait === "bass_weight");
  assert(bassTrait);
  assert.strictEqual(bassTrait?.value, "heavy");
  assert(bassTrait?.provenance.some((entry) => entry.kind === "derived_from_audio"));

  const intensityTrait = bassAggressiveRecord.traitLabels?.find((label) => label.trait === "intensity");
  assert(intensityTrait);
  assert.strictEqual(intensityTrait?.value, "aggressive");
  assert((intensityTrait?.confidence ?? 0) >= 0.5);

  const bassRole = bassAggressiveRecord.roleLabels?.find((label) => label.role === "bass");
  assert(bassRole);
  assert(bassRole?.provenance.some((entry) => entry.kind === "derived_from_audio"));
});

await check("merges filename, manual, and parameter provenance into deterministic labels", () => {
  const labeled = derivePresetLabels(makeRecord({
    id: "fixture.multi-provenance",
    source: {
      kind: "ableton",
      ableton: {
        trackName: "Lead Stack",
        deviceName: "Serum2",
        presetName: "Neon Lead Atlas",
        pluginName: "Serum2",
      },
      manual: {
        sourceName: "qa-note",
        notes: "Foreground lead hook with bright cutoff and short attack.",
      },
    },
    parameters: [
      {
        id: "a-cutoff",
        name: "A Cutoff",
        normalizedValue: 0.82,
        value: 0.82,
        provenance: [{ kind: "derived_from_parameters", path: "device.parameters.a-cutoff" }],
      },
      {
        id: "drive",
        name: "Drive",
        normalizedValue: 0.71,
        value: 0.71,
        provenance: [{ kind: "derived_from_parameters", path: "device.parameters.drive" }],
      },
      {
        id: "attack",
        name: "Attack",
        normalizedValue: 0.08,
        value: 0.08,
        provenance: [{ kind: "derived_from_parameters", path: "device.parameters.attack" }],
      },
    ],
  }));

  validatePresetRecord(labeled);

  const leadRole = labeled.roleLabels?.find((label) => label.role === "lead");
  assert(leadRole);
  assert((leadRole?.confidence ?? 0) > 0.9);
  assert(leadRole?.provenance.some((entry) => entry.kind === "derived_from_filename"));
  assert(leadRole?.provenance.some((entry) => entry.kind === "manual"));
  assert(leadRole?.provenance.every((entry) => entry.detail?.includes("Label derivation v1")));

  const brightnessTrait = labeled.traitLabels?.find((label) => label.trait === "brightness");
  assert(brightnessTrait);
  assert.strictEqual(brightnessTrait?.value, "bright");
  assert(brightnessTrait?.provenance.some((entry) => entry.kind === "derived_from_parameters"));

  const intensityTrait = labeled.traitLabels?.find((label) => label.trait === "intensity");
  assert(intensityTrait);
  assert.strictEqual(intensityTrait?.value, "aggressive");

  const articulationTrait = labeled.traitLabels?.find((label) => label.trait === "articulation");
  assert(articulationTrait);
  assert.strictEqual(articulationTrait?.value, "plucked");

  fs.writeFileSync(
    path.join(evidenceDir, "task-7-label-provenance.txt"),
    [
      `lead.confidence=${leadRole?.confidence ?? 0}`,
      `lead.provenanceKinds=${leadRole?.provenance.map((entry) => entry.kind).join(",")}`,
      `brightness.confidence=${brightnessTrait?.confidence ?? 0}`,
      `intensity.confidence=${intensityTrait?.confidence ?? 0}`,
      `articulation.confidence=${articulationTrait?.confidence ?? 0}`,
      `lead.details=${leadRole?.provenance.map((entry) => entry.detail).join(" | ")}`,
    ].join("\n") + "\n",
  );
});

await check("keeps metadata-only fallback deterministic without emitting audio-derived traits", () => {
  const fallbackRecord = derivePresetLabels(makeRecord({
    id: "fixture.metadata-only-fallback",
    file: {
      relativePath: "Pads/PD Warm Strings Soft Sustain.SerumPreset",
      fileName: "PD Warm Strings Soft Sustain.SerumPreset",
      extension: ".SerumPreset",
    },
    source: { kind: "filename" },
  }));

  validatePresetRecord(fallbackRecord);
  assert.strictEqual(fallbackRecord.audioFeatures, undefined);
  assert.strictEqual(fallbackRecord.parameters, undefined);

  const padRole = fallbackRecord.roleLabels?.find((label) => label.role === "pad");
  assert(padRole);
  assert((padRole?.confidence ?? 0) > 0);
  assert((padRole?.confidence ?? 0) <= 0.45);
  assert(padRole?.provenance.every((entry) => entry.kind === "derived_from_filename"));

  const darkTrait = fallbackRecord.traitLabels?.find((label) => label.trait === "brightness");
  assert(darkTrait);
  assert.strictEqual(darkTrait?.value, "dark");
  assert((darkTrait?.confidence ?? 0) <= 0.45);

  const softTrait = fallbackRecord.traitLabels?.find((label) => label.trait === "intensity");
  assert(softTrait);
  assert.strictEqual(softTrait?.value, "soft");
  assert((softTrait?.confidence ?? 0) <= 0.45);

  const sustainedTrait = fallbackRecord.traitLabels?.find((label) => label.trait === "articulation");
  assert(sustainedTrait);
  assert.strictEqual(sustainedTrait?.value, "sustained");
  assert((sustainedTrait?.confidence ?? 0) <= 0.45);

  for (const label of [...(fallbackRecord.roleLabels ?? []), ...(fallbackRecord.traitLabels ?? [])]) {
    assert(label.provenance.every((entry) => entry.kind === "derived_from_filename"));
    assert(label.provenance.every((entry) => entry.detail?.includes("Label derivation v1")));
    assert(label.provenance.every((entry) => entry.kind !== "derived_from_audio"));
  }

  fs.writeFileSync(
    path.join(evidenceDir, "task-7-label-fallback.txt"),
    [
      `record=${fallbackRecord.file.relativePath}`,
      `roleLabels=${fallbackRecord.roleLabels?.map((label) => `${label.role}:${label.confidence}`).join(",") ?? ""}`,
      `traitLabels=${fallbackRecord.traitLabels?.map((label) => `${label.trait}=${label.value}:${label.confidence}`).join(",") ?? ""}`,
      `roleProvenance=${padRole?.provenance.map((entry) => `${entry.kind}:${entry.path}`).join(",") ?? ""}`,
      `traitProvenance=${fallbackRecord.traitLabels?.flatMap((label) => label.provenance.map((entry) => `${label.trait}:${entry.kind}:${entry.path}`)).join(",") ?? ""}`,
    ].join("\n") + "\n",
  );
});

process.on("exit", () => {
  console.log(`preset label derivation: ${pass} passed`);
  if (pass !== 3) process.exitCode = 1;
});
