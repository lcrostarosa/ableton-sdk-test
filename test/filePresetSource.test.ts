import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FilePresetSource } from "../src/common/filePresetSource.ts";
import { validatePresetRecord } from "../src/common/presetCorpus.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(rootDir, "test", "fixtures", "preset-files");
const metadataFixtureRoot = path.join(fixtureRoot, "metadata");
const malformedFixtureRoot = path.join(fixtureRoot, "malformed");
const evidenceDir = path.join(rootDir, ".sisyphus", "evidence");

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

console.log("file preset source:");

fs.mkdirSync(evidenceDir, { recursive: true });

await check(
  "scans synthetic .SerumPreset fixtures into metadata-only records",
  () => {
    const result = new FilePresetSource().scan(metadataFixtureRoot);
    const relativePaths = result.records.map(
      (record) => record.file.relativePath,
    );

    assert.deepStrictEqual(relativePaths, [
      "Bass/BR Weight Room.SerumPreset",
      "Lead/LD Neon Hook.SerumPreset",
      "Pad/PD Velvet Drift.SerumPreset",
    ]);
    assert(result.probeResults.every((probe) => probe.status === "disabled"));

    for (const record of result.records) {
      validatePresetRecord(record);
      assert.strictEqual(record.source.kind, "filename");
      assert.strictEqual(record.parameters, undefined);
      assert.strictEqual(record.audioFeatures, undefined);
      assert(!record.file.relativePath.startsWith("/"));
      assert(!record.file.relativePath.includes(rootDir));
      assert.strictEqual(record.file.extension, ".SerumPreset");
      assert(record.id.startsWith("file."));
      assert(record.metadataTraits?.category);
      assert(
        record.metadataTraits?.provenance?.some(
          (entry) => entry.kind === "derived_from_filename",
        ),
      );
      assert(
        record.provenance.some(
          (entry) => entry.kind === "derived_from_filename",
        ),
      );
      assert(record.provenance.some((entry) => entry.kind === "fixture"));
    }

    assert.strictEqual(result.records[0]?.metadataTraits?.category, "Bass");
    assert.strictEqual(result.records[1]?.metadataTraits?.category, "Lead");
    assert.strictEqual(result.records[2]?.metadataTraits?.category, "Pad");

    const evidence =
      result.records
        .map((record) =>
          [
            `id=${record.id}`,
            `relativePath=${record.file.relativePath}`,
            `category=${record.metadataTraits?.category ?? ""}`,
            `tags=${(record.metadataTraits?.tags ?? []).join(",")}`,
          ].join("\n"),
        )
        .join("\n---\n") + "\n";

    fs.writeFileSync(
      path.join(evidenceDir, "task-4-file-source-metadata.txt"),
      evidence,
    );
  },
);

await check(
  "fails closed to metadata-only records when the optional parse probe sees malformed payloads",
  () => {
    const result = new FilePresetSource({
      parseProbe: { enabled: true, maxBytes: 256 },
    }).scan(malformedFixtureRoot);
    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.probeResults.length, 1);

    const record = validatePresetRecord(result.records[0]);
    const probeResult = result.probeResults[0];

    assert.strictEqual(record.source.kind, "filename");
    assert.strictEqual(record.parameters, undefined);
    assert.strictEqual(record.audioFeatures, undefined);
    assert.strictEqual(
      record.file.relativePath,
      "Broken/BR Corrupt Header.SerumPreset",
    );
    assert.strictEqual(probeResult?.status, "parse_failed");
    assert(probeResult?.detail?.includes("XferJson payload parse failed"));
    assert(!probeResult?.detail?.includes(rootDir));

    const evidence =
      [
        `relativePath=${record.file.relativePath}`,
        `status=${probeResult?.status ?? "missing"}`,
        `detail=${probeResult?.detail ?? ""}`,
        `category=${record.metadataTraits?.category ?? ""}`,
      ].join("\n") + "\n";
    fs.writeFileSync(
      path.join(evidenceDir, "task-4-file-source-malformed.txt"),
      evidence,
    );
  },
);

await check(
  "treats headers beyond the configured probe window as missing",
  () => {
    const tempRoot = fs.mkdtempSync(path.join(evidenceDir, "task-4-file-source-boundary-"));
    try {
      const presetDir = path.join(tempRoot, "Boundary");
      fs.mkdirSync(presetDir, { recursive: true });

      const relativePath = "Boundary/BR Probe Window.SerumPreset";
      const presetPath = path.join(presetDir, "BR Probe Window.SerumPreset");
      const prefix = "a".repeat(300);
      const payload = JSON.stringify({ author: "Hidden", bank: "Boundary", category: "Lead" });
      fs.writeFileSync(presetPath, prefix + "XferJson" + payload);

      const result = new FilePresetSource({
        parseProbe: { enabled: true, maxBytes: 256 },
      }).scan(tempRoot);

      assert.strictEqual(result.records.length, 1);
      assert.strictEqual(result.probeResults.length, 1);

      const record = validatePresetRecord(result.records[0]);
      const probeResult = result.probeResults[0];

      assert.strictEqual(record.file.relativePath, relativePath);
      assert.strictEqual(record.source.kind, "filename");
      assert.strictEqual(record.parameters, undefined);
      assert.strictEqual(record.audioFeatures, undefined);
      assert.strictEqual(probeResult?.status, "header_missing");
      assert(probeResult?.detail?.includes("first 256 bytes"));
      assert(!probeResult?.detail?.includes("parsed"));

      const evidence = [
        `relativePath=${record.file.relativePath}`,
        `status=${probeResult?.status ?? "missing"}`,
        `detail=${probeResult?.detail ?? ""}`,
        `category=${record.metadataTraits?.category ?? ""}`,
      ].join("\n") + "\n";
      fs.writeFileSync(
        path.join(evidenceDir, "task-4-file-source-boundary.txt"),
        evidence,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

console.log(`\n${pass} checks passed`);
