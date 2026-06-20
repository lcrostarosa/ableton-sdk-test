import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESET_CORPUS_SCHEMA_VERSION,
  isPresetRecord,
  validatePresetCorpus,
  validatePresetRecord,
} from "../src/presetCorpus.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(rootDir, "test", "fixtures", "preset-corpus");

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

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
}

console.log("preset corpus schema:");

await check("validates the synthetic V1 fixture corpus", () => {
  const corpus = validatePresetCorpus(readJson("small-corpus.json"));
  assert.strictEqual(corpus.schemaVersion, PRESET_CORPUS_SCHEMA_VERSION);
  assert.strictEqual(corpus.records.length, 12);
  assert.strictEqual(corpus.records[0]?.id, "preset-001");
  assert.strictEqual(corpus.records[0]?.file.fileName, "BS Anchor Sub.fxp");
  assert.strictEqual(corpus.records[1]?.parameters?.[0]?.id, "filter.cutoff");
  assert.strictEqual(
    corpus.records[1]?.audioFeatures?.features?.spectralFlatness,
    0.11,
  );
  assert.strictEqual(corpus.records[4]?.metadataTraits?.tags?.[1], "pad");
  assert.strictEqual(corpus.records[5]?.parameters, undefined);
  assert.strictEqual(corpus.records[10]?.audioFeatures, undefined);
});

await check("accepts filename-only partial evidence records", () => {
  const record = validatePresetRecord({
    schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
    id: "fixture.partial",
    file: {
      relativePath: "synthetic/PD Partial.fxp",
      fileName: "PD Partial.fxp",
    },
    source: { kind: "filename" },
    provenance: [{ kind: "derived_from_filename", path: "file.fileName" }],
  });
  assert.strictEqual(record.parameters, undefined);
  assert.strictEqual(record.audioFeatures, undefined);
  assert.strictEqual(record.provenance[0]?.kind, "derived_from_filename");
});

await check("narrows unknown values with isPresetRecord", () => {
  const valid = validatePresetCorpus(readJson("small-corpus.json")).records[0];
  assert.strictEqual(isPresetRecord(valid), true);
  assert.strictEqual(
    isPresetRecord({ schemaVersion: PRESET_CORPUS_SCHEMA_VERSION }),
    false,
  );
});

await check("rejects invalid provenance with a deterministic path", () => {
  assert.throws(
    () => validatePresetCorpus(readJson("invalid-provenance.json")),
    /corpus\.records\[0\]\.provenance\[0\]\.kind: expected one of manual, derived_from_filename, derived_from_parameters, derived_from_audio, inferred_by_similarity, fixture/,
  );
});

await check("rejects invalid numeric ranges with deterministic paths", () => {
  assert.throws(
    () =>
      validatePresetRecord({
        schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
        id: "fixture.bad-range",
        file: { relativePath: "synthetic/Bad.fxp", fileName: "Bad.fxp" },
        source: { kind: "fixture" },
        audioFeatures: { highRatio: 1.5 },
        provenance: [{ kind: "fixture" }],
      }),
    /record\.audioFeatures\.highRatio: expected number between 0 and 1/,
  );
});

console.log(`\n${pass} checks passed`);
