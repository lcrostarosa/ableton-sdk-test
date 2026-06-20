import fs from "node:fs";
import path from "node:path";
import { derivePresetLabels } from "./presetLabels.ts";
import {
  type AudioFeatureVector,
  type MetadataTraits,
  PRESET_CORPUS_SCHEMA_VERSION,
  type PresetCorpus,
  type PresetRecord,
  type Provenance,
  type RoleLabel,
  type TraitLabel,
  validatePresetCorpus,
} from "./presetCorpus.ts";
import { LATEST_PRESET_CORPUS_REPORT_PATH } from "./presetCorpusStore.ts";

const PRESET_SIMILARITY_REPORT_SCHEMA_VERSION = "preset-similarity-report/v1" as const;
const SIMILARITY_METHOD = "preset-similarity/v1" as const;

const AUDIO_WEIGHT = 0.56;
const PARAMETER_WEIGHT = 0.24;
const TRAIT_WEIGHT = 0.1;
const ROLE_WEIGHT = 0.06;
const METADATA_WEIGHT = 0.04;

interface ScoredComponent {
  name: SimilarityComponentName;
  score: number;
  coverage: number;
}

type SimilarityComponentName = "audio" | "parameters" | "traits" | "roles" | "metadata";

interface SimilarityComponentDefinition {
  name: SimilarityComponentName;
  weight: number;
  expected: boolean;
  component: ScoredComponent | null;
}

interface NumericRange {
  min: number;
  max: number;
}

interface SimilarityContext {
  audioRanges: Map<string, NumericRange>;
}

export interface PresetSimilarityOptions {
  limit?: number;
}

export interface PresetSimilarityNeighbor {
  id: string;
  name: string;
  relativePath: string;
  score: number;
  confidence: number;
  roles: string[];
  traits: string[];
  provenance: Provenance[];
  similarity: {
    method: typeof SIMILARITY_METHOD;
    rawScore: number;
    matchedComponents: SimilarityComponentName[];
    missingComponents: SimilarityComponentName[];
    provenance: Provenance[];
  };
}

export interface PresetSimilarityReport {
  schemaVersion: typeof PRESET_SIMILARITY_REPORT_SCHEMA_VERSION;
  method: typeof SIMILARITY_METHOD;
  corpusSchemaVersion: typeof PRESET_CORPUS_SCHEMA_VERSION;
  query: {
    id: string;
    name: string;
    relativePath: string;
    roles: string[];
    traits: string[];
    provenance: Provenance[];
  };
  similar: PresetSimilarityNeighbor[];
}

export function buildPresetSimilarityReport(
  corpus: PresetCorpus,
  queryId: string,
  options: PresetSimilarityOptions = {},
): PresetSimilarityReport {
  const validatedCorpus = validatePresetCorpus(corpus);
  const preparedRecords = validatedCorpus.records.map(prepareRecordForSimilarity);
  const query = preparedRecords.find((record) => record.id === queryId);
  if (!query) {
    throw new Error(`Unknown preset id: ${queryId}`);
  }

  const context: SimilarityContext = {
    audioRanges: buildAudioRanges(preparedRecords),
  };

  const limit = Math.max(1, options.limit ?? 5);
  const similar = preparedRecords
    .filter((record) => record.id !== query.id)
    .map((record) => scorePresetSimilarity(query, record, context))
    .sort(compareNeighbors)
    .slice(0, limit);

  return {
    schemaVersion: PRESET_SIMILARITY_REPORT_SCHEMA_VERSION,
    method: SIMILARITY_METHOD,
    corpusSchemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
    query: summarizeRecord(query),
    similar,
  };
}

export function formatPresetSimilarityReportText(report: PresetSimilarityReport): string {
  const lines = [
    "Preset similarity report",
    `Query: ${report.query.id} | ${report.query.name}`,
    `Roles: ${joinOrFallback(report.query.roles)}`,
    `Traits: ${joinOrFallback(report.query.traits)}`,
    "",
    "Top similar presets:",
  ];

  for (const [index, neighbor] of report.similar.entries()) {
    lines.push(
      `${index + 1}. ${neighbor.id} | ${neighbor.name} | score=${neighbor.score.toFixed(3)} | confidence=${neighbor.confidence.toFixed(3)} | roles=${joinOrFallback(neighbor.roles)} | traits=${joinOrFallback(neighbor.traits)}`,
    );
  }

  return lines.join("\n") + "\n";
}

export function writePresetSimilarityReport(
  report: PresetSimilarityReport,
  outPath: string = LATEST_PRESET_CORPUS_REPORT_PATH,
): string {
  const resolvedPath = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(report, null, 2) + "\n");
  return resolvedPath;
}

function prepareRecordForSimilarity(record: PresetRecord): PresetRecord {
  return record.traitLabels && record.roleLabels ? record : derivePresetLabels(record);
}

function summarizeRecord(record: PresetRecord) {
  return {
    id: record.id,
    name: getPresetName(record),
    relativePath: record.file.relativePath,
    roles: listRoles(record.roleLabels),
    traits: listTraits(record.traitLabels),
    provenance: record.provenance,
  };
}

function scorePresetSimilarity(
  query: PresetRecord,
  candidate: PresetRecord,
  context: SimilarityContext,
): PresetSimilarityNeighbor {
  const components: SimilarityComponentDefinition[] = [
    {
      name: "audio",
      weight: AUDIO_WEIGHT,
      expected: hasAudioEvidence(query),
      component: scoreAudioComponent(query.audioFeatures, candidate.audioFeatures, context.audioRanges),
    },
    {
      name: "parameters",
      weight: PARAMETER_WEIGHT,
      expected: hasParameterEvidence(query),
      component: scoreParameterComponent(query, candidate),
    },
    {
      name: "traits",
      weight: TRAIT_WEIGHT,
      expected: hasTraitEvidence(query),
      component: scoreTraitComponent(query.traitLabels, candidate.traitLabels),
    },
    {
      name: "roles",
      weight: ROLE_WEIGHT,
      expected: hasRoleEvidence(query),
      component: scoreRoleComponent(query.roleLabels, candidate.roleLabels),
    },
    {
      name: "metadata",
      weight: METADATA_WEIGHT,
      expected: hasMetadataEvidence(query),
      component: scoreMetadataComponent(query.metadataTraits, candidate.metadataTraits),
    },
  ];

  let weightedScore = 0;
  let comparedWeight = 0;
  let coveredWeight = 0;
  let expectedWeight = 0;
  const matchedComponents: SimilarityComponentName[] = [];
  const missingComponents: SimilarityComponentName[] = [];

  for (const component of components) {
    if (component.expected) expectedWeight += component.weight;
    if (!component.component) {
      if (component.expected) missingComponents.push(component.name);
      continue;
    }
    weightedScore += component.component.score * component.weight;
    comparedWeight += component.weight;
    coveredWeight += component.weight * component.component.coverage;
    matchedComponents.push(component.name);
    if (component.component.coverage < 1 && component.expected) {
      missingComponents.push(component.name);
    }
  }

  const rawScore = comparedWeight > 0 ? weightedScore / comparedWeight : 0;
  const confidence = expectedWeight > 0 ? coveredWeight / expectedWeight : comparedWeight > 0 ? 1 : 0;
  const score = clamp01(rawScore * (0.65 + 0.35 * confidence));
  const roles = listRoles(candidate.roleLabels);
  const traits = listTraits(candidate.traitLabels);

  return {
    id: candidate.id,
    name: getPresetName(candidate),
    relativePath: candidate.file.relativePath,
    score,
    confidence: clamp01(confidence),
    roles,
    traits,
    provenance: candidate.provenance,
    similarity: {
      method: SIMILARITY_METHOD,
      rawScore,
      matchedComponents,
      missingComponents: uniqueStrings(missingComponents),
      provenance: [
        {
          kind: "inferred_by_similarity",
          sourceRecordId: query.id,
          confidence: clamp01(confidence),
          detail: `Similarity v1 matched components [${matchedComponents.join(", ") || "none"}] and penalized missing components [${uniqueStrings(missingComponents).join(", ") || "none"}].`,
        },
      ],
    },
  };
}

function scoreAudioComponent(
  query: AudioFeatureVector | undefined,
  candidate: AudioFeatureVector | undefined,
  ranges: Map<string, NumericRange>,
): ScoredComponent | null {
  const queryVector = toAudioComponentMap(query);
  if (queryVector.size === 0) return null;
  const candidateVector = toAudioComponentMap(candidate);
  const keys = [...queryVector.keys()].sort();
  let total = 0;
  let matched = 0;

  for (const key of keys) {
    const queryValue = queryVector.get(key);
    const candidateValue = candidateVector.get(key);
    if (queryValue === undefined || candidateValue === undefined) continue;
    const range = ranges.get(key);
    const span = range ? range.max - range.min : 0;
    const normalized = span > 0 ? 1 - Math.min(1, Math.abs(queryValue - candidateValue) / span) : queryValue === candidateValue ? 1 : 0;
    total += normalized;
    matched++;
  }

  if (matched === 0) return null;
  return {
    name: "audio",
    score: total / matched,
    coverage: matched / keys.length,
  };
}

function scoreParameterComponent(query: PresetRecord, candidate: PresetRecord): ScoredComponent | null {
  const queryParams = toParameterMap(query);
  if (queryParams.size === 0) return null;
  const candidateParams = toParameterMap(candidate);
  let total = 0;
  let matched = 0;
  for (const [id, queryValue] of queryParams) {
    const candidateValue = candidateParams.get(id);
    if (candidateValue === undefined) continue;
    total += 1 - Math.min(1, Math.abs(queryValue - candidateValue));
    matched++;
  }
  if (matched === 0) return null;
  return {
    name: "parameters",
    score: total / matched,
    coverage: matched / queryParams.size,
  };
}

function scoreTraitComponent(
  query: readonly TraitLabel[] | undefined,
  candidate: readonly TraitLabel[] | undefined,
): ScoredComponent | null {
  const queryMap = toTraitMap(query);
  if (queryMap.size === 0) return null;
  const candidateMap = toTraitMap(candidate);
  return scoreWeightedOverlap("traits", queryMap, candidateMap);
}

function scoreRoleComponent(
  query: readonly RoleLabel[] | undefined,
  candidate: readonly RoleLabel[] | undefined,
): ScoredComponent | null {
  const queryMap = toRoleMap(query);
  if (queryMap.size === 0) return null;
  const candidateMap = toRoleMap(candidate);
  return scoreWeightedOverlap("roles", queryMap, candidateMap);
}

function scoreMetadataComponent(
  query: MetadataTraits | undefined,
  candidate: MetadataTraits | undefined,
): ScoredComponent | null {
  const queryMap = toMetadataMap(query);
  if (queryMap.size === 0) return null;
  const candidateMap = toMetadataMap(candidate);
  let total = 0;
  let matched = 0;

  for (const [key, queryValue] of queryMap) {
    const candidateValue = candidateMap.get(key);
    if (candidateValue === undefined) continue;
    if (typeof queryValue === "number" && typeof candidateValue === "number") {
      total += 1 - Math.min(1, Math.abs(queryValue - candidateValue));
    } else {
      total += queryValue === candidateValue ? 1 : 0;
    }
    matched++;
  }

  if (matched === 0) return null;
  return {
    name: "metadata",
    score: total / matched,
    coverage: matched / queryMap.size,
  };
}

function scoreWeightedOverlap(
  name: "traits" | "roles",
  queryMap: Map<string, number>,
  candidateMap: Map<string, number>,
): ScoredComponent | null {
  let total = 0;
  let matched = 0;
  for (const [key, queryWeight] of queryMap) {
    const candidateWeight = candidateMap.get(key);
    if (candidateWeight === undefined) continue;
    total += Math.min(queryWeight, candidateWeight);
    matched++;
  }
  if (matched === 0) return null;
  return {
    name,
    score: total / matched,
    coverage: matched / queryMap.size,
  };
}

function buildAudioRanges(records: readonly PresetRecord[]): Map<string, NumericRange> {
  const values = new Map<string, number[]>();
  for (const record of records) {
    for (const [key, value] of toAudioComponentMap(record.audioFeatures)) {
      const existing = values.get(key);
      if (existing) existing.push(value);
      else values.set(key, [value]);
    }
  }

  const ranges = new Map<string, NumericRange>();
  for (const [key, series] of values) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of series) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      ranges.set(key, { min, max });
    }
  }
  return ranges;
}

function toAudioComponentMap(audioFeatures: AudioFeatureVector | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!audioFeatures) return map;

  pushFinite(map, "centroid", audioFeatures.centroid);
  pushFinite(map, "highRatio", audioFeatures.highRatio);
  pushFinite(map, "bassRatio", audioFeatures.bassRatio);
  pushFinite(map, "rms", audioFeatures.rms);

  const featureEntries = Object.entries(audioFeatures.features ?? {})
    .filter(([key, value]) => Number.isFinite(value) && !key.startsWith("analysis") && !key.startsWith("protocol"))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of featureEntries) {
    map.set(`feature:${key}`, value);
  }
  return map;
}

function toParameterMap(record: PresetRecord): Map<string, number> {
  const map = new Map<string, number>();
  const parameters = [...(record.parameters ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  for (const parameter of parameters) {
    if (typeof parameter.normalizedValue === "number" && Number.isFinite(parameter.normalizedValue)) {
      map.set(parameter.id, clamp01(parameter.normalizedValue));
    }
  }
  return map;
}

function toTraitMap(labels: readonly TraitLabel[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const label of [...(labels ?? [])].sort(compareTraitLabelEntries)) {
    const key = `${label.trait}:${label.value ?? ""}`;
    map.set(key, clamp01(label.confidence ?? 0.5));
  }
  return map;
}

function toRoleMap(labels: readonly RoleLabel[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const label of [...(labels ?? [])].sort(compareRoleLabelEntries)) {
    map.set(label.role, clamp01(label.confidence ?? 0.5));
  }
  return map;
}

function toMetadataMap(metadata: MetadataTraits | undefined): Map<string, string | number> {
  const map = new Map<string, string | number>();
  if (!metadata) return map;
  if (metadata.category) map.set("category", metadata.category.toLowerCase());
  if (metadata.style) map.set("style", metadata.style.toLowerCase());
  if (metadata.key) map.set("key", metadata.key.toLowerCase());
  const tags = [...(metadata.tags ?? [])].map((tag) => tag.toLowerCase()).sort();
  if (tags.length > 0) map.set("tags", tags.join("|"));
  if (typeof metadata.bpm === "number" && Number.isFinite(metadata.bpm)) {
    map.set("bpm", clamp01(metadata.bpm / 200));
  }
  return map;
}

function compareNeighbors(left: PresetSimilarityNeighbor, right: PresetSimilarityNeighbor): number {
  return (
    right.score - left.score ||
    right.confidence - left.confidence ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function compareTraitLabelEntries(left: TraitLabel, right: TraitLabel): number {
  return left.trait.localeCompare(right.trait) || (left.value ?? "").localeCompare(right.value ?? "");
}

function compareRoleLabelEntries(left: RoleLabel, right: RoleLabel): number {
  return left.role.localeCompare(right.role);
}

function listRoles(labels: readonly RoleLabel[] | undefined): string[] {
  return [...(labels ?? [])].map((label) => label.role).sort((left, right) => left.localeCompare(right));
}

function listTraits(labels: readonly TraitLabel[] | undefined): string[] {
  return [...(labels ?? [])]
    .map((label) => `${label.trait}${label.value ? `=${label.value}` : ""}`)
    .sort((left, right) => left.localeCompare(right));
}

function getPresetName(record: PresetRecord): string {
  const presetName = record.source.ableton?.presetName?.trim();
  if (presetName) return presetName;
  const fileName = record.file.fileName;
  const extension = record.file.extension;
  if (extension && fileName.endsWith(extension)) {
    return fileName.slice(0, -extension.length);
  }
  return fileName;
}

function hasAudioEvidence(record: PresetRecord): boolean {
  return toAudioComponentMap(record.audioFeatures).size > 0;
}

function hasParameterEvidence(record: PresetRecord): boolean {
  return toParameterMap(record).size > 0;
}

function hasTraitEvidence(record: PresetRecord): boolean {
  return toTraitMap(record.traitLabels).size > 0;
}

function hasRoleEvidence(record: PresetRecord): boolean {
  return toRoleMap(record.roleLabels).size > 0;
}

function hasMetadataEvidence(record: PresetRecord): boolean {
  return toMetadataMap(record.metadataTraits).size > 0;
}

function joinOrFallback(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function pushFinite(map: Map<string, number>, key: string, value: number | undefined): void {
  if (typeof value === "number" && Number.isFinite(value)) map.set(key, value);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right)) as T[];
}
