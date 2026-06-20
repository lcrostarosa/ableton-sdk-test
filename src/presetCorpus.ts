export const PRESET_CORPUS_SCHEMA_VERSION = "preset-corpus/v1" as const;

const PRESET_SOURCE_KINDS = ["filename", "ableton", "manual", "fixture"] as const;
const PROVENANCE_KINDS = [
  "manual",
  "derived_from_filename",
  "derived_from_parameters",
  "derived_from_audio",
  "inferred_by_similarity",
  "fixture",
] as const;

export type PresetSourceKind = typeof PRESET_SOURCE_KINDS[number];
export type ProvenanceKind = typeof PROVENANCE_KINDS[number];

export interface PresetCorpus {
  schemaVersion: typeof PRESET_CORPUS_SCHEMA_VERSION;
  records: PresetRecord[];
}

export interface PresetRecord {
  schemaVersion: typeof PRESET_CORPUS_SCHEMA_VERSION;
  id: string;
  file: PresetFileMetadata;
  source: PresetSourceMetadata;
  parameters?: ParameterSnapshot[];
  audioFeatures?: AudioFeatureVector;
  metadataTraits?: MetadataTraits;
  traitLabels?: TraitLabel[];
  roleLabels?: RoleLabel[];
  similarity?: SimilarityResult[];
  provenance: Provenance[];
}

export interface PresetFileMetadata {
  relativePath: string;
  fileName: string;
  extension?: string;
  sizeBytes?: number;
  modifiedIso?: string;
  sha256?: string;
}

export interface PresetSourceMetadata {
  kind: PresetSourceKind;
  synth?: string;
  ableton?: AbletonSourceMetadata;
  manual?: ManualSourceMetadata;
}

export interface AbletonSourceMetadata {
  trackName?: string;
  deviceName?: string;
  presetName?: string;
  pluginName?: string;
}

export interface ManualSourceMetadata {
  author?: string;
  notes?: string;
  sourceName?: string;
}

export interface ParameterSnapshot {
  id: string;
  name?: string;
  normalizedValue?: number;
  value?: string | number | boolean;
  displayValue?: string;
  unit?: string;
  provenance?: Provenance[];
}

export interface AudioFeatureVector {
  sampleRate?: number;
  durationSeconds?: number;
  centroid?: number;
  highRatio?: number;
  bassRatio?: number;
  rms?: number;
  features?: Record<string, number>;
  provenance?: Provenance[];
}

export interface MetadataTraits {
  author?: string;
  vendor?: string;
  bank?: string;
  category?: string;
  style?: string;
  bpm?: number;
  key?: string;
  tags?: string[];
  provenance?: Provenance[];
}

export interface TraitLabel {
  trait: string;
  value?: string;
  confidence?: number;
  provenance: Provenance[];
}

export interface RoleLabel {
  role: string;
  confidence?: number;
  provenance: Provenance[];
}

export interface SimilarityResult {
  recordId: string;
  score: number;
  rank?: number;
  method?: string;
  provenance: Provenance[];
}

export interface Provenance {
  kind: ProvenanceKind;
  path?: string;
  detail?: string;
  confidence?: number;
  at?: string;
  sourceRecordId?: string;
}

export function validatePresetCorpus(value: unknown): PresetCorpus {
  const corpus = expectRecord(value, "corpus");
  const schemaVersion = expectSchemaVersion(corpus.schemaVersion, "corpus.schemaVersion");
  const records = expectArray(corpus.records, "corpus.records").map((record, index) =>
    validatePresetRecord(record, `corpus.records[${index}]`)
  );
  return { schemaVersion, records };
}

export function validatePresetRecord(value: unknown, path = "record"): PresetRecord {
  const record = expectRecord(value, path);
  const result: PresetRecord = {
    schemaVersion: expectSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    id: expectString(record.id, `${path}.id`),
    file: validateFileMetadata(record.file, `${path}.file`),
    source: validateSourceMetadata(record.source, `${path}.source`),
    provenance: validateProvenanceList(record.provenance, `${path}.provenance`),
  };

  if (has(record, "parameters")) result.parameters = expectArray(record.parameters, `${path}.parameters`).map((item, index) => validateParameterSnapshot(item, `${path}.parameters[${index}]`));
  if (has(record, "audioFeatures")) result.audioFeatures = validateAudioFeatureVector(record.audioFeatures, `${path}.audioFeatures`);
  if (has(record, "metadataTraits")) result.metadataTraits = validateMetadataTraits(record.metadataTraits, `${path}.metadataTraits`);
  if (has(record, "traitLabels")) result.traitLabels = expectArray(record.traitLabels, `${path}.traitLabels`).map((item, index) => validateTraitLabel(item, `${path}.traitLabels[${index}]`));
  if (has(record, "roleLabels")) result.roleLabels = expectArray(record.roleLabels, `${path}.roleLabels`).map((item, index) => validateRoleLabel(item, `${path}.roleLabels[${index}]`));
  if (has(record, "similarity")) result.similarity = expectArray(record.similarity, `${path}.similarity`).map((item, index) => validateSimilarityResult(item, `${path}.similarity[${index}]`));

  return result;
}

export function isPresetRecord(value: unknown): value is PresetRecord {
  try {
    validatePresetRecord(value);
    return true;
  } catch {
    return false;
  }
}

function validateFileMetadata(value: unknown, path: string): PresetFileMetadata {
  const input = expectRecord(value, path);
  const result: PresetFileMetadata = {
    relativePath: expectString(input.relativePath, `${path}.relativePath`),
    fileName: expectString(input.fileName, `${path}.fileName`),
  };
  if (has(input, "extension")) result.extension = expectString(input.extension, `${path}.extension`);
  if (has(input, "sizeBytes")) result.sizeBytes = expectNonNegativeNumber(input.sizeBytes, `${path}.sizeBytes`);
  if (has(input, "modifiedIso")) result.modifiedIso = expectString(input.modifiedIso, `${path}.modifiedIso`);
  if (has(input, "sha256")) result.sha256 = expectString(input.sha256, `${path}.sha256`);
  return result;
}

function validateSourceMetadata(value: unknown, path: string): PresetSourceMetadata {
  const input = expectRecord(value, path);
  const result: PresetSourceMetadata = {
    kind: expectLiteral(input.kind, PRESET_SOURCE_KINDS, `${path}.kind`),
  };
  if (has(input, "synth")) result.synth = expectString(input.synth, `${path}.synth`);
  if (has(input, "ableton")) result.ableton = validateAbletonSourceMetadata(input.ableton, `${path}.ableton`);
  if (has(input, "manual")) result.manual = validateManualSourceMetadata(input.manual, `${path}.manual`);
  return result;
}

function validateAbletonSourceMetadata(value: unknown, path: string): AbletonSourceMetadata {
  const input = expectRecord(value, path);
  const result: AbletonSourceMetadata = {};
  if (has(input, "trackName")) result.trackName = expectString(input.trackName, `${path}.trackName`);
  if (has(input, "deviceName")) result.deviceName = expectString(input.deviceName, `${path}.deviceName`);
  if (has(input, "presetName")) result.presetName = expectString(input.presetName, `${path}.presetName`);
  if (has(input, "pluginName")) result.pluginName = expectString(input.pluginName, `${path}.pluginName`);
  return result;
}

function validateManualSourceMetadata(value: unknown, path: string): ManualSourceMetadata {
  const input = expectRecord(value, path);
  const result: ManualSourceMetadata = {};
  if (has(input, "author")) result.author = expectString(input.author, `${path}.author`);
  if (has(input, "notes")) result.notes = expectString(input.notes, `${path}.notes`);
  if (has(input, "sourceName")) result.sourceName = expectString(input.sourceName, `${path}.sourceName`);
  return result;
}

function validateParameterSnapshot(value: unknown, path: string): ParameterSnapshot {
  const input = expectRecord(value, path);
  const result: ParameterSnapshot = { id: expectString(input.id, `${path}.id`) };
  if (has(input, "name")) result.name = expectString(input.name, `${path}.name`);
  if (has(input, "normalizedValue")) result.normalizedValue = expectNumberInRange(input.normalizedValue, `${path}.normalizedValue`, 0, 1);
  if (has(input, "value")) result.value = expectScalar(input.value, `${path}.value`);
  if (has(input, "displayValue")) result.displayValue = expectString(input.displayValue, `${path}.displayValue`);
  if (has(input, "unit")) result.unit = expectString(input.unit, `${path}.unit`);
  if (has(input, "provenance")) result.provenance = validateProvenanceList(input.provenance, `${path}.provenance`);
  return result;
}

function validateAudioFeatureVector(value: unknown, path: string): AudioFeatureVector {
  const input = expectRecord(value, path);
  const result: AudioFeatureVector = {};
  if (has(input, "sampleRate")) result.sampleRate = expectPositiveNumber(input.sampleRate, `${path}.sampleRate`);
  if (has(input, "durationSeconds")) result.durationSeconds = expectNonNegativeNumber(input.durationSeconds, `${path}.durationSeconds`);
  if (has(input, "centroid")) result.centroid = expectNonNegativeNumber(input.centroid, `${path}.centroid`);
  if (has(input, "highRatio")) result.highRatio = expectNumberInRange(input.highRatio, `${path}.highRatio`, 0, 1);
  if (has(input, "bassRatio")) result.bassRatio = expectNumberInRange(input.bassRatio, `${path}.bassRatio`, 0, 1);
  if (has(input, "rms")) result.rms = expectNonNegativeNumber(input.rms, `${path}.rms`);
  if (has(input, "features")) result.features = validateNumberMap(input.features, `${path}.features`);
  if (has(input, "provenance")) result.provenance = validateProvenanceList(input.provenance, `${path}.provenance`);
  return result;
}

function validateMetadataTraits(value: unknown, path: string): MetadataTraits {
  const input = expectRecord(value, path);
  const result: MetadataTraits = {};
  if (has(input, "author")) result.author = expectString(input.author, `${path}.author`);
  if (has(input, "vendor")) result.vendor = expectString(input.vendor, `${path}.vendor`);
  if (has(input, "bank")) result.bank = expectString(input.bank, `${path}.bank`);
  if (has(input, "category")) result.category = expectString(input.category, `${path}.category`);
  if (has(input, "style")) result.style = expectString(input.style, `${path}.style`);
  if (has(input, "bpm")) result.bpm = expectPositiveNumber(input.bpm, `${path}.bpm`);
  if (has(input, "key")) result.key = expectString(input.key, `${path}.key`);
  if (has(input, "tags")) result.tags = expectArray(input.tags, `${path}.tags`).map((item, index) => expectString(item, `${path}.tags[${index}]`));
  if (has(input, "provenance")) result.provenance = validateProvenanceList(input.provenance, `${path}.provenance`);
  return result;
}

function validateTraitLabel(value: unknown, path: string): TraitLabel {
  const input = expectRecord(value, path);
  const result: TraitLabel = {
    trait: expectString(input.trait, `${path}.trait`),
    provenance: validateProvenanceList(input.provenance, `${path}.provenance`),
  };
  if (has(input, "value")) result.value = expectString(input.value, `${path}.value`);
  if (has(input, "confidence")) result.confidence = expectNumberInRange(input.confidence, `${path}.confidence`, 0, 1);
  return result;
}

function validateRoleLabel(value: unknown, path: string): RoleLabel {
  const input = expectRecord(value, path);
  const result: RoleLabel = {
    role: expectString(input.role, `${path}.role`),
    provenance: validateProvenanceList(input.provenance, `${path}.provenance`),
  };
  if (has(input, "confidence")) result.confidence = expectNumberInRange(input.confidence, `${path}.confidence`, 0, 1);
  return result;
}

function validateSimilarityResult(value: unknown, path: string): SimilarityResult {
  const input = expectRecord(value, path);
  const result: SimilarityResult = {
    recordId: expectString(input.recordId, `${path}.recordId`),
    score: expectNumberInRange(input.score, `${path}.score`, 0, 1),
    provenance: validateProvenanceList(input.provenance, `${path}.provenance`),
  };
  if (has(input, "rank")) result.rank = expectNonNegativeNumber(input.rank, `${path}.rank`);
  if (has(input, "method")) result.method = expectString(input.method, `${path}.method`);
  return result;
}

function validateProvenanceList(value: unknown, path: string): Provenance[] {
  const items = expectArray(value, path).map((item, index) => validateProvenance(item, `${path}[${index}]`));
  if (items.length === 0) throw new Error(`${path}: expected at least one provenance entry`);
  return items;
}

function validateProvenance(value: unknown, path: string): Provenance {
  const input = expectRecord(value, path);
  const result: Provenance = {
    kind: expectLiteral(input.kind, PROVENANCE_KINDS, `${path}.kind`),
  };
  if (has(input, "path")) result.path = expectString(input.path, `${path}.path`);
  if (has(input, "detail")) result.detail = expectString(input.detail, `${path}.detail`);
  if (has(input, "confidence")) result.confidence = expectNumberInRange(input.confidence, `${path}.confidence`, 0, 1);
  if (has(input, "at")) result.at = expectString(input.at, `${path}.at`);
  if (has(input, "sourceRecordId")) result.sourceRecordId = expectString(input.sourceRecordId, `${path}.sourceRecordId`);
  return result;
}

function validateNumberMap(value: unknown, path: string): Record<string, number> {
  const input = expectRecord(value, path);
  const result: Record<string, number> = {};
  for (const key of Object.keys(input).sort()) result[key] = expectFiniteNumber(input[key], `${path}.${key}`);
  return result;
}

function expectSchemaVersion(value: unknown, path: string): typeof PRESET_CORPUS_SCHEMA_VERSION {
  if (value !== PRESET_CORPUS_SCHEMA_VERSION) throw new Error(`${path}: expected ${PRESET_CORPUS_SCHEMA_VERSION}`);
  return PRESET_CORPUS_SCHEMA_VERSION;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path}: expected object`);
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}: expected non-empty string`);
  return value;
}

function expectScalar(value: unknown, path: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path}: expected string, number, or boolean`);
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path}: expected finite number`);
  return value;
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (number < 0) throw new Error(`${path}: expected number >= 0`);
  return number;
}

function expectPositiveNumber(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (number <= 0) throw new Error(`${path}: expected number > 0`);
  return number;
}

function expectNumberInRange(value: unknown, path: string, min: number, max: number): number {
  const number = expectFiniteNumber(value, path);
  if (number < min || number > max) throw new Error(`${path}: expected number between ${min} and ${max}`);
  return number;
}

function expectLiteral<const Values extends readonly string[]>(value: unknown, values: Values, path: string): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${path}: expected one of ${values.join(", ")}`);
  return value;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
