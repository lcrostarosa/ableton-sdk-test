import fs from "node:fs";
import path from "node:path";
import {
  PRESET_CORPUS_SCHEMA_VERSION,
  type PresetCorpus,
  validatePresetCorpus,
} from "./presetCorpus.ts";

export const FIXTURE_PRESET_CORPUS_PATH = "test/fixtures/preset-corpus/small-corpus.json" as const;
export const LOCAL_PRESET_CORPUS_PATH = ".serum-corpus/preset-corpus.json" as const;
export const LATEST_PRESET_CORPUS_REPORT_PATH = ".serum-corpus/reports/latest.json" as const;

const PRESET_CORPUS_JSON_INDENT = 2;

export function readPresetCorpusFile(corpusPath: string = LOCAL_PRESET_CORPUS_PATH): PresetCorpus | null {
  if (!fs.existsSync(corpusPath)) return null;
  return validatePresetCorpus(JSON.parse(fs.readFileSync(corpusPath, "utf8")));
}

export function writePresetCorpusFile(corpusPath: string, corpus: PresetCorpus): PresetCorpus {
  const validatedCorpus = validatePresetCorpus(corpus);
  fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
  fs.writeFileSync(corpusPath, formatPresetCorpusJson(validatedCorpus));
  return validatedCorpus;
}

export function updatePresetCorpusFile(
  corpusPath: string,
  updater: (corpus: PresetCorpus) => PresetCorpus,
): PresetCorpus {
  const currentCorpus = readPresetCorpusFile(corpusPath) ?? {
    schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
    records: [],
  };
  const nextCorpus = validatePresetCorpus(updater(currentCorpus));
  return writePresetCorpusFile(corpusPath, nextCorpus);
}

export function formatPresetCorpusJson(corpus: PresetCorpus): string {
  return JSON.stringify(validatePresetCorpus(corpus), null, PRESET_CORPUS_JSON_INDENT) + "\n";
}
