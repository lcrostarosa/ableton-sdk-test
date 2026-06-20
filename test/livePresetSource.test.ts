import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAcquisitionGateResult,
  evaluateAcquisitionGates,
} from "../src/acquisitionGates.ts";
import { LiveDevicePresetSource } from "../src/livePresetSource.ts";
import { validatePresetRecord } from "../src/presetCorpus.ts";
import {
  fakeDevice,
  fakeTrack,
  makeFakeRig,
} from "./fixtures/liveSdk/fakeLiveRig.ts";

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

console.log("live preset source:");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const gateReport = evaluateAcquisitionGates({
  filenameMetadataAvailable: true,
  gateResults: [
    createAcquisitionGateResult({
      capabilityId: "serum-preset-metadata-parse",
      status: "FAIL",
      reason: "Fixture mode does not parse proprietary .SerumPreset payloads.",
      evidencePath: ".sisyphus/evidence/task-5-live-source-params.txt",
      details: "Manual/current-preset capture remains the intended fallback.",
    }),
    createAcquisitionGateResult({
      capabilityId: "ableton-device-parameter-snapshot",
      status: "PASS",
      reason:
        "Fake Live rig exposes Serum2 parameters through DeviceParameter.getValue().",
      evidencePath: "liveAdapter.test.ts",
      details: "Exposed parameters are readable without Ableton.",
    }),
    createAcquisitionGateResult({
      capabilityId: "ableton-audio-render-capture",
      status: "SKIPPED",
      reason:
        "This task records only an optional render reference placeholder.",
      evidencePath: ".sisyphus/evidence/task-5-live-source-params.txt",
      details: "Audio feature extraction is downstream work.",
    }),
    createAcquisitionGateResult({
      capabilityId: "manual-current-preset-capture",
      status: "PASS",
      reason: "Fixture inputs identify the currently loaded preset manually.",
      evidencePath: ".sisyphus/evidence/task-5-live-source-params.txt",
      details:
        "Current-preset capture is valid even without automatic enumeration.",
    }),
    createAcquisitionGateResult({
      capabilityId: "max-for-live-preset-probe",
      status: "FAIL",
      reason:
        "No proven PluginDevice.presets fixture exists for this repository.",
      evidencePath: ".sisyphus/evidence/task-5-live-source-params.txt",
      details: "Enumeration/loading remains optional and unproven.",
    }),
  ],
});

await check(
  "captures current preset metadata and normalized fake-parameter snapshots",
  async () => {
    const tmpWav = path.join(
      import.meta.dirname,
      ".tmp_test",
      "live-preset-source.wav",
    );
    fs.mkdirSync(path.dirname(tmpWav), { recursive: true });
    const { track } = makeFakeRig(tmpWav);
    const source = new LiveDevicePresetSource();

    const record = await source.capture({
      track,
      presetName: "Neon Atlas",
      manual: {
        sourceName: "task-5-fixture",
        author: "qa",
        config: "oscA=basic_shapes; fx=off",
        notes: "Captured from the currently loaded Serum2 instance.",
      },
      renderReference: ".sisyphus/evidence/render-placeholder.wav",
      gateReport,
      capturedAt: "2026-06-19T00:00:00.000Z",
    });

    validatePresetRecord(record);
    assert.strictEqual(record.source.kind, "ableton");
    assert.strictEqual(record.source.ableton?.trackName, "Serum Bass");
    assert.strictEqual(record.source.ableton?.deviceName, "Serum2");
    assert.strictEqual(record.source.ableton?.presetName, "Neon Atlas");
    assert.strictEqual(record.source.manual?.sourceName, "task-5-fixture");
    assert(record.source.manual?.notes?.includes("oscA=basic_shapes; fx=off"));
    assert(
      record.source.manual?.notes?.includes(
        "renderReference=.sisyphus/evidence/render-placeholder.wav",
      ),
    );
    assert.strictEqual(record.parameters?.length, 7);
    const drive = record.parameters?.find((parameter) => parameter.name === "Drive");
    assert(drive);
    assert.strictEqual(drive?.id, "drive");
    assert.strictEqual(drive?.value, 0);
    assert.strictEqual(drive?.normalizedValue, 0);
    const cutoff = record.parameters?.find(
      (parameter) => parameter.name === "A Cutoff",
    );
    assert(cutoff);
    assert.strictEqual(cutoff?.id, "a-cutoff");
    assert.strictEqual(cutoff?.value, 0.45);
    assert(Math.abs((cutoff?.normalizedValue ?? 0) - 0.45) < 1e-9);
    const resonance = record.parameters?.find(
      (parameter) => parameter.name === "A Resonance",
    );
    assert(resonance);
    assert.strictEqual(resonance?.id, "a-resonance");
    assert.strictEqual(resonance?.value, 0.1);
    assert(Math.abs((resonance?.normalizedValue ?? 0) - 0.1) < 1e-9);
    const octave = record.parameters?.find(
      (parameter) => parameter.name === "A Octave",
    );
    assert(octave);
    assert.strictEqual(octave?.value, 0);
    assert.strictEqual(octave?.normalizedValue, 0.5);
    for (const parameter of [drive, cutoff, resonance, octave]) {
      assert(
        parameter?.provenance?.some(
          (entry) => entry.kind === "derived_from_parameters",
        ),
      );
    }
    assert(
      record.provenance.some(
        (entry) =>
          entry.path === "acquisitionGates.manual-current-preset-capture",
      ),
    );
    assert(
      record.provenance.some(
        (entry) => entry.path === "acquisitionGates.fallbackSelection",
      ),
    );

    const evidence =
      [
        `id=${record.id}`,
        `relativePath=${record.file.relativePath}`,
        `track=${record.source.ableton?.trackName}`,
        `device=${record.source.ableton?.deviceName}`,
        `preset=${record.source.ableton?.presetName}`,
        `parameterCount=${record.parameters ? record.parameters.length : 0}`,
        `parameterIds=${(record.parameters ?? []).map((parameter) => parameter.id).join(",")}`,
        `fallbackPath=${record.provenance.find((entry) => entry.path === "acquisitionGates.fallbackSelection")?.detail ?? "missing"}`,
      ].join("\n") + "\n";

    fs.writeFileSync(
      path.join(evidenceDir, "task-5-live-source-params.txt"),
      evidence,
    );
  },
);

await check(
  "keeps a partial record when one exposed parameter cannot be read",
  async () => {
    const source = new LiveDevicePresetSource();
    const track = fakeTrack("Serum Bass", [
      fakeDevice("Serum2", () => [
        {
          name: "Drive",
          min: 0,
          max: 1,
          getValue: async () => {
            throw new Error("parameter offline");
          },
          setValue: async () => undefined,
        },
      ]),
    ]);

    const record = await source.capture({
      track,
      presetName: "Unreadable Drive",
      manual: {
        sourceName: "task-5-unreadable-param",
        config: "drive unreadable",
      },
      gateReport,
      capturedAt: "2026-06-19T00:03:00.000Z",
    });

    validatePresetRecord(record);
    assert.strictEqual(record.parameters?.length, 1);
    const drive = record.parameters?.[0];
    assert.strictEqual(drive?.id, "drive");
    assert.strictEqual(drive?.value, undefined);
    assert.strictEqual(drive?.normalizedValue, undefined);
    assert(
      drive?.provenance?.some((entry) =>
        entry.detail?.includes("did not return a readable value"),
      ),
    );
  },
);

await check(
  "emits a partial record when the current device exposes zero parameters",
  async () => {
    const track = fakeTrack("Serum Bass", [fakeDevice("Serum2", () => [])]);
    const source = new LiveDevicePresetSource();

    const record = await source.capture({
      track,
      presetName: "Manual Init",
      manual: {
        sourceName: "task-5-zero-params",
        config: "manual preset name only",
      },
      gateReport: evaluateAcquisitionGates({
        filenameMetadataAvailable: false,
        gateResults: [
          createAcquisitionGateResult({
            capabilityId: "serum-preset-metadata-parse",
            status: "FAIL",
            reason: "No .SerumPreset parser is present in fixture mode.",
            evidencePath: ".sisyphus/evidence/task-5-live-source-no-params.txt",
          }),
          createAcquisitionGateResult({
            capabilityId: "ableton-device-parameter-snapshot",
            status: "FAIL",
            reason: "The selected fake device exposes zero parameters.",
            evidencePath: ".sisyphus/evidence/task-5-live-source-no-params.txt",
          }),
          createAcquisitionGateResult({
            capabilityId: "ableton-audio-render-capture",
            status: "SKIPPED",
            reason: "No render is attempted in this unit test.",
            evidencePath: ".sisyphus/evidence/task-5-live-source-no-params.txt",
          }),
          createAcquisitionGateResult({
            capabilityId: "manual-current-preset-capture",
            status: "PASS",
            reason: "Manual preset naming remains available.",
            evidencePath: ".sisyphus/evidence/task-5-live-source-no-params.txt",
          }),
          createAcquisitionGateResult({
            capabilityId: "max-for-live-preset-probe",
            status: "FAIL",
            reason: "Enumeration/loading is still unproven.",
            evidencePath: ".sisyphus/evidence/task-5-live-source-no-params.txt",
          }),
        ],
      }),
      capturedAt: "2026-06-19T00:05:00.000Z",
    });

    validatePresetRecord(record);
    assert.strictEqual(record.source.kind, "ableton");
    assert.strictEqual(record.parameters, undefined);
    assert.strictEqual(record.source.ableton?.presetName, "Manual Init");
    assert.strictEqual(record.source.manual?.sourceName, "task-5-zero-params");
    assert(
      record.provenance.some(
        (entry) =>
          entry.path === "acquisitionGates.ableton-device-parameter-snapshot",
      ),
    );
    const parameterCount = 0;

    const evidence =
      [
        `id=${record.id}`,
        `relativePath=${record.file.relativePath}`,
        `track=${record.source.ableton?.trackName}`,
        `device=${record.source.ableton?.deviceName}`,
        `preset=${record.source.ableton?.presetName}`,
        `parameterCount=${parameterCount}`,
        `parameterFallback=${record.provenance.find((entry) => entry.path === "acquisitionGates.ableton-device-parameter-snapshot")?.detail ?? "missing"}`,
      ].join("\n") + "\n";

    fs.writeFileSync(
      path.join(evidenceDir, "task-5-live-source-no-params.txt"),
      evidence,
    );
  },
);

console.log(`Passed ${pass} live preset source checks.`);
