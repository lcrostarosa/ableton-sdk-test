import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  createAcquisitionGateResult,
  evaluateAcquisitionGates,
  formatAcquisitionGateReportMarkdown,
  formatFallbackSummary,
} from "../src/common/acquisitionGates.ts";

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

console.log("Acquisition gate fallback matrix:");

const evidenceDir = path.join(import.meta.dirname, ".sisyphus", "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const fixtureReport = evaluateAcquisitionGates({
  filenameMetadataAvailable: true,
  gateResults: [
    createAcquisitionGateResult({
      capabilityId: "serum-preset-metadata-parse",
      status: "FAIL",
      reason: "Fixture mode does not parse proprietary .SerumPreset payloads.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-fixture.txt",
      details: "Filename/folder metadata remains available.",
    }),
    createAcquisitionGateResult({
      capabilityId: "ableton-device-parameter-snapshot",
      status: "PASS",
      reason:
        "Fake Live rig exposes Serum2 parameters through DeviceParameter.getValue().",
      evidencePath: "liveAdapter.test.ts",
      details:
        "Fixture captures normalized parameter snapshots without Ableton.",
    }),
    createAcquisitionGateResult({
      capabilityId: "ableton-audio-render-capture",
      status: "PASS",
      reason:
        "Fake Live rig renders the routed AI Ear track through renderPreFxAudio.",
      evidencePath: "liveAdapter.test.ts",
      details: "Fixture render path produces deterministic WAV output.",
    }),
    createAcquisitionGateResult({
      capabilityId: "manual-current-preset-capture",
      status: "PASS",
      reason:
        "Fixture inputs allow the currently loaded preset to be identified manually.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-fixture.txt",
      details: "Used when automatic enumeration/loading is unavailable.",
    }),
    createAcquisitionGateResult({
      capabilityId: "max-for-live-preset-probe",
      status: "FAIL",
      reason:
        "No proven PluginDevice.presets fixture exists for this repository.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-fixture.txt",
      details: "Enumeration/loading remains optional and unproven.",
    }),
  ],
});

const minimalReport = evaluateAcquisitionGates({
  filenameMetadataAvailable: true,
  gateResults: [
    createAcquisitionGateResult({
      capabilityId: "serum-preset-metadata-parse",
      status: "FAIL",
      reason: "No parser is implemented in this task.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-minimal.txt",
    }),
    createAcquisitionGateResult({
      capabilityId: "ableton-device-parameter-snapshot",
      status: "FAIL",
      reason: "No live device snapshot is available in the minimal fixture.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-minimal.txt",
    }),
    createAcquisitionGateResult({
      capabilityId: "ableton-audio-render-capture",
      status: "FAIL",
      reason:
        "No routed audio render lane is available in the minimal fixture.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-minimal.txt",
    }),
    createAcquisitionGateResult({
      capabilityId: "manual-current-preset-capture",
      status: "FAIL",
      reason:
        "No manually loaded current preset is available in the minimal fixture.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-minimal.txt",
    }),
    createAcquisitionGateResult({
      capabilityId: "max-for-live-preset-probe",
      status: "FAIL",
      reason:
        "No Max for Live preset probe is available in the minimal fixture.",
      evidencePath: ".sisyphus/evidence/task-2-fallback-minimal.txt",
    }),
  ],
});

await check(
  "fixture fallback selects manual/current-preset capture with audio and parameters",
  () => {
    assert.strictEqual(
      fixtureReport.fallbackSelection.capturePath,
      "manual_current_preset",
    );
    assert.strictEqual(
      fixtureReport.fallbackSelection.metadataPath,
      "filename_folder_metadata",
    );
    assert.strictEqual(
      fixtureReport.fallbackSelection.featureAvailability.parameters,
      true,
    );
    assert.strictEqual(
      fixtureReport.fallbackSelection.featureAvailability.audio,
      true,
    );
    assert.strictEqual(
      fixtureReport.fallbackSelection.featureAvailability.parameterSimilarity,
      true,
    );
    assert.strictEqual(
      fixtureReport.fallbackSelection.featureAvailability.audioSimilarity,
      true,
    );
    assert(
      fixtureReport.fallbackSelection.notes.some((note) =>
        /manual\/current-preset capture/.test(note),
      ),
    );
    assert(
      fixtureReport.fallbackSelection.notes.some((note) =>
        /filename\/folder metadata/.test(note),
      ),
    );
  },
);

await check(
  "minimal fallback degrades to metadata-only indexing with no audio or parameter similarity",
  () => {
    assert.strictEqual(
      minimalReport.fallbackSelection.capturePath,
      "metadata_only",
    );
    assert.strictEqual(
      minimalReport.fallbackSelection.metadataPath,
      "filename_folder_metadata",
    );
    assert.strictEqual(
      minimalReport.fallbackSelection.featureAvailability.parameters,
      false,
    );
    assert.strictEqual(
      minimalReport.fallbackSelection.featureAvailability.audio,
      false,
    );
    assert.strictEqual(
      minimalReport.fallbackSelection.featureAvailability.parameterSimilarity,
      false,
    );
    assert.strictEqual(
      minimalReport.fallbackSelection.featureAvailability.audioSimilarity,
      false,
    );
    assert(
      minimalReport.fallbackSelection.notes.some((note) =>
        /metadata-only/.test(note),
      ),
    );
    assert(
      minimalReport.fallbackSelection.notes.some((note) =>
        /audio features are marked missing/.test(note),
      ),
    );
    assert(
      minimalReport.fallbackSelection.notes.some((note) =>
        /parameter similarity is disabled/.test(note),
      ),
    );
  },
);

await check(
  "gate report markdown includes fixed statuses and evidence paths",
  () => {
    const markdown = formatAcquisitionGateReportMarkdown(fixtureReport);
    assert(
      markdown.includes(
        "| max-for-live-preset-probe | Max for Live preset probe | FAIL |",
      ),
    );
    assert(markdown.includes(".sisyphus/evidence/task-2-fallback-fixture.txt"));
    assert(markdown.includes("Capture path: manual/current-preset capture"));
    assert(markdown.includes("Audio similarity: enabled"));
  },
);

await check("writes deterministic task evidence artifacts", () => {
  const combinedReport = [
    formatAcquisitionGateReportMarkdown(fixtureReport),
    "",
    "# Minimal Fallback Scenario",
    "",
    formatAcquisitionGateReportMarkdown(minimalReport),
  ].join("\n");

  fs.writeFileSync(
    path.join(evidenceDir, "task-2-acquisition-gates.md"),
    combinedReport,
  );
  fs.writeFileSync(
    path.join(evidenceDir, "task-2-fallback-fixture.txt"),
    formatFallbackSummary(fixtureReport),
  );
  fs.writeFileSync(
    path.join(evidenceDir, "task-2-fallback-minimal.txt"),
    formatFallbackSummary(minimalReport),
  );

  assert(
    fs
      .readFileSync(
        path.join(evidenceDir, "task-2-acquisition-gates.md"),
        "utf8",
      )
      .includes("# Acquisition Gate Report"),
  );
  assert(
    fs
      .readFileSync(
        path.join(evidenceDir, "task-2-fallback-fixture.txt"),
        "utf8",
      )
      .includes("capture=manual_current_preset"),
  );
  assert(
    fs
      .readFileSync(
        path.join(evidenceDir, "task-2-fallback-minimal.txt"),
        "utf8",
      )
      .includes("capture=metadata_only"),
  );
});

console.log(`Passed ${pass} acquisition gate checks.`);
