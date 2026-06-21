import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPresetCorpusFile, FIXTURE_PRESET_CORPUS_PATH, LATEST_PRESET_CORPUS_REPORT_PATH } from "../src/common/presetCorpusStore.ts";
import {
  buildPresetSimilarityReport,
  formatPresetSimilarityReportText,
} from "../src/common/presetSimilarity.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");
const fixturePath = path.join(rootDir, FIXTURE_PRESET_CORPUS_PATH);
const latestReportPath = path.join(rootDir, LATEST_PRESET_CORPUS_REPORT_PATH);

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

console.log("preset similarity:");

fs.mkdirSync(evidenceDir, { recursive: true });

await check("ranks bass-like fixtures above dissimilar presets and penalizes missing audio confidence", () => {
  const corpus = readPresetCorpusFile(fixturePath);
  assert(corpus);
  const report = buildPresetSimilarityReport(corpus, "preset-001");
  const ids = report.similar.map((item) => item.id);
  assert.deepStrictEqual(ids.slice(0, 3), ["preset-002", "preset-003", "preset-004"]);

  const nearest = report.similar[0];
  const partial = report.similar[2];
  assert(nearest);
  assert(partial);
  assert((nearest.score ?? 0) > (partial.score ?? 0));
  assert((nearest.confidence ?? 0) > (partial.confidence ?? 0));
  assert(nearest.roles.includes("bass"));
  assert(partial.roles.includes("bass"));
  assert(partial.similarity.missingComponents.includes("audio"));

  const evidenceLines = report.similar.map(
    (item, index) => `${index + 1}. ${item.id} score=${item.score.toFixed(3)} confidence=${item.confidence.toFixed(3)}`,
  );
  fs.writeFileSync(
    path.join(evidenceDir, "task-8-similarity-ranking.txt"),
    evidenceLines.join("\n") + "\n",
  );
});

await check("formats a deterministic report and the CLI writes the default JSON output", () => {
  const corpus = readPresetCorpusFile(fixturePath);
  assert(corpus);
  const report = buildPresetSimilarityReport(corpus, "preset-001");
  const text = formatPresetSimilarityReportText(report);
  assert(text.includes("Query: preset-001 | BS Anchor Sub"));
  assert(text.includes("1. preset-002 | BS Round Support"));

  const stdout = execFileSync(
    process.execPath,
    [
      "src/common/runPresetReport.ts",
      "--corpus",
      FIXTURE_PRESET_CORPUS_PATH,
      "--query",
      "preset-001",
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );

  assert(stdout.includes("Preset similarity report"));
  assert(stdout.includes("Report JSON: "));
  const persisted = JSON.parse(fs.readFileSync(latestReportPath, "utf8")) as { query?: { id?: string }, similar?: Array<{ id?: string }> };
  assert.strictEqual(persisted.query?.id, "preset-001");
  assert.strictEqual(persisted.similar?.[0]?.id, "preset-002");
});

console.log(`\n${pass} checks passed`);
