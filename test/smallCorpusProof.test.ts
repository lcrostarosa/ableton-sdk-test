import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivePresetLabels } from "../src/common/presetLabels.ts";
import { FIXTURE_PRESET_CORPUS_PATH, readPresetCorpusFile } from "../src/common/presetCorpusStore.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");
const fixturePath = path.join(rootDir, FIXTURE_PRESET_CORPUS_PATH);
const fixtureProofPath = path.join(evidenceDir, "task-9-small-corpus-fixture-proof.txt");
const rigUnavailablePath = path.join(evidenceDir, "task-9-rig-unavailable.md");

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
        "  ✗ " + name + " - " + (error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
    });
}

function countManualLabelAvailability(record: ReturnType<typeof derivePresetLabels>): number {
  const roleManual = record.roleLabels?.some((label) =>
    label.provenance.some((provenance) => provenance.kind === "manual"),
  );
  const traitManual = record.traitLabels?.some((label) =>
    label.provenance.some((provenance) => provenance.kind === "manual"),
  );
  const recordManual = record.provenance.some((provenance) => provenance.kind === "manual");
  const sourceManual = Boolean(record.source.manual);
  return roleManual || traitManual || recordManual || sourceManual ? 1 : 0;
}

console.log("small corpus fixture proof:");

fs.mkdirSync(evidenceDir, { recursive: true });

await check("proves the sanitized fixture corpus in fallback mode and writes task-9 evidence", () => {
  const corpus = readPresetCorpusFile(fixturePath);
  assert(corpus, "fixture corpus should exist");
  assert(corpus.records.length >= 10 && corpus.records.length <= 25);

  const labeledRecords = corpus.records.map((record) => derivePresetLabels(record));
  const audioAvailable = corpus.records.filter((record) => record.audioFeatures).length;
  const parameterAvailable = corpus.records.filter((record) => record.parameters?.length).length;
  const metadataParseAvailable = 0;
  const manualLabelAvailable = labeledRecords.reduce(
    (count, record) => count + countManualLabelAvailability(record),
    0,
  );

  const labelProvenanceCounts = new Map<string, number>();
  for (const record of labeledRecords) {
    for (const label of [...(record.roleLabels ?? []), ...(record.traitLabels ?? [])]) {
      for (const provenance of label.provenance) {
        labelProvenanceCounts.set(
          provenance.kind,
          (labelProvenanceCounts.get(provenance.kind) ?? 0) + 1,
        );
      }
    }
  }

  const stdout = execFileSync(
    process.execPath,
    ["runPresetReport.ts", "--corpus", FIXTURE_PRESET_CORPUS_PATH, "--query", "preset-001"],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );

  assert(stdout.includes("Preset similarity report"));
  assert(stdout.includes("Query: preset-001 | BS Anchor Sub"));

  const neighborLines = stdout
    .split("\n")
    .filter((line) => /^\d+\. preset-/.test(line))
    .slice(0, 3);

  assert.strictEqual(neighborLines.length, 3);

  const missingAudio = corpus.records.length - audioAvailable;
  const missingParameters = corpus.records.length - parameterAvailable;
  const missingMetadataParse = corpus.records.length - metadataParseAvailable;
  const missingManualLabel = corpus.records.length - manualLabelAvailable;

  const proofLines = [
    "Task 9 small-corpus fixture proof",
    "",
    "Selected acquisition path: fixture fallback",
    "Fallback reason: real Ableton + current Serum manual capture was not proven available in this repo/session, so fixture mode was selected per task guidance.",
    `Corpus count: ${corpus.records.length}`,
    "",
    "Feature availability counts:",
    `- audio: ${audioAvailable}/${corpus.records.length}`,
    `- parameters: ${parameterAvailable}/${corpus.records.length}`,
    `- metadata parse: ${metadataParseAvailable}/${corpus.records.length}`,
    `- manual label: ${manualLabelAvailable}/${corpus.records.length}`,
    "",
    "Label provenance counts:",
    ...[...labelProvenanceCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `- ${kind}: ${count}`),
    "",
    "Nearest-neighbor examples from CLI:",
    ...neighborLines.map((line) => `- ${line}`),
    "",
    "Missing feature reasons:",
    `- audio missing (${missingAudio}): fixture-mode proof intentionally includes metadata/parameter-only records where no sanitized audio render was captured.`,
    `- parameters missing (${missingParameters}): fixture-mode proof intentionally includes metadata/audio-only records where no sanitized Ableton parameter snapshot was captured.`,
    `- metadata parse missing (${missingMetadataParse}): fixture corpus uses sanitized filename/folder metadata only; proprietary .SerumPreset payload parsing remains unavailable in this proof.`,
    `- manual label missing (${missingManualLabel}): some fixture records rely on derived filename/audio/parameter labels only and do not claim a manual label source.`,
    "",
    "Synthetic role coverage:",
    "- bass, pad, lead, pluck, arp, keys, fx",
    "",
  ];

  fs.writeFileSync(fixtureProofPath, proofLines.join("\n"));
  fs.writeFileSync(
    rigUnavailablePath,
    [
      "# Rig Unavailable",
      "",
      "Fixture mode was used for Task 9.",
      "",
      "Reason: this repository/session does not provide verified access to a live Ableton + Serum manual-capture rig for the current preset, and Task 9 explicitly allows fixture fallback instead of blocking on hardware.",
      "",
      "Selected path: sanitized fixture corpus + report CLI proof.",
      "",
    ].join("\n"),
  );
});

console.log(`\n${pass} checks passed`);
