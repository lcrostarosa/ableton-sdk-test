import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_PRESET_CORPUS_PATH,
  LATEST_PRESET_CORPUS_REPORT_PATH,
  LOCAL_PRESET_CORPUS_PATH,
  formatPresetCorpusJson,
  readPresetCorpusFile,
  updatePresetCorpusFile,
  writePresetCorpusFile,
} from "../src/common/presetCorpusStore.ts";
import { validatePresetCorpus } from "../src/common/presetCorpus.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");
const fixturePath = path.join(rootDir, FIXTURE_PRESET_CORPUS_PATH);

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

console.log("preset corpus store:");

fs.mkdirSync(evidenceDir, { recursive: true });

await check("exposes the expected path constants", () => {
  assert.strictEqual(
    FIXTURE_PRESET_CORPUS_PATH,
    "test/fixtures/preset-corpus/small-corpus.json",
  );
  assert.strictEqual(
    LOCAL_PRESET_CORPUS_PATH,
    ".serum-corpus/preset-corpus.json",
  );
  assert.strictEqual(
    LATEST_PRESET_CORPUS_REPORT_PATH,
    ".serum-corpus/reports/latest.json",
  );
});

await check(
  "round-trips a validated corpus with stable JSON formatting",
  () => {
    const corpus = validatePresetCorpus(
      JSON.parse(fs.readFileSync(fixturePath, "utf8")),
    );
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "preset-corpus-store-"),
    );
    const corpusPath = path.join(tempDir, "preset-corpus.json");

    try {
      const written = writePresetCorpusFile(corpusPath, corpus);
      assert.deepStrictEqual(written, corpus);
      assert.strictEqual(
        fs.readFileSync(corpusPath, "utf8"),
        formatPresetCorpusJson(corpus),
      );

      const loaded = readPresetCorpusFile(corpusPath);
      assert.deepStrictEqual(loaded, corpus);

      const updated = updatePresetCorpusFile(corpusPath, (current) => ({
        ...current,
        records: current.records.map((record, index) =>
          index === 0
            ? { ...record, id: "fixture.filename-only.updated" }
            : record,
        ),
      }));
      assert.strictEqual(
        updated.records[0]?.id,
        "fixture.filename-only.updated",
      );
      assert.strictEqual(
        readPresetCorpusFile(corpusPath)?.records[0]?.id,
        "fixture.filename-only.updated",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    fs.writeFileSync(
      path.join(evidenceDir, "task-3-json-roundtrip.txt"),
      "preset corpus store roundtrip verified\n",
    );
  },
);

await check("rejects unsupported schema versions through validation", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "preset-corpus-version-"),
  );
  const corpusPath = path.join(tempDir, "preset-corpus.json");

  try {
    fs.writeFileSync(
      corpusPath,
      JSON.stringify(
        { schemaVersion: "preset-corpus/v2", records: [] },
        null,
        2,
      ) + "\n",
    );

    assert.throws(
      () => readPresetCorpusFile(corpusPath),
      /corpus\.schemaVersion: expected preset-corpus\/v1/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  fs.writeFileSync(
    path.join(evidenceDir, "task-3-json-version-error.txt"),
    "preset corpus store rejects unsupported schema versions\n",
  );
});

await Promise.resolve().then(() => {
  console.log(`\n${pass} checks passed`);
});
