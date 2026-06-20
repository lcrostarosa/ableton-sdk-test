import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PRESET_CORPUS_SCHEMA_VERSION,
  type MetadataTraits,
  type PresetRecord,
  validatePresetRecord,
} from "./presetCorpus.ts";
import { derivePresetLabels } from "./presetLabels.ts";

export const DEFAULT_PRESET_FILE_EXTENSION = ".SerumPreset" as const;
export const DEFAULT_PARSE_PROBE_MAX_BYTES = 4096;

const XFER_JSON_HEADER = "XferJson";

export interface FilePresetParseProbeOptions {
  enabled?: boolean;
  maxBytes?: number;
}

export interface FilePresetSourceOptions {
  includeModifiedTime?: boolean;
  includeSizeBytes?: boolean;
  parseProbe?: FilePresetParseProbeOptions;
}

export interface FilePresetProbeResult {
  relativePath: string;
  status: "disabled" | "header_missing" | "parsed" | "parse_failed";
  detail?: string;
  extractedFields?: string[];
}

export interface FilePresetScanResult {
  records: PresetRecord[];
  probeResults: FilePresetProbeResult[];
}

export class FilePresetSource {
  private readonly includeModifiedTime: boolean;
  private readonly includeSizeBytes: boolean;
  private readonly parseProbeEnabled: boolean;
  private readonly parseProbeMaxBytes: number;

  constructor(options: FilePresetSourceOptions = {}) {
    this.includeModifiedTime = options.includeModifiedTime ?? true;
    this.includeSizeBytes = options.includeSizeBytes ?? true;
    this.parseProbeEnabled = options.parseProbe?.enabled ?? false;
    this.parseProbeMaxBytes = validateProbeByteLimit(options.parseProbe?.maxBytes ?? DEFAULT_PARSE_PROBE_MAX_BYTES);
  }

  scan(scanRootPath: string): FilePresetScanResult {
    const absoluteRootPath = path.resolve(scanRootPath);
    const rootStats = fs.statSync(absoluteRootPath, { throwIfNoEntry: false });
    if (!rootStats) throw new Error(`scan root does not exist: ${scanRootPath}`);
    if (!rootStats.isDirectory()) throw new Error(`scan root is not a directory: ${scanRootPath}`);

    const presetFiles = walkPresetFiles(absoluteRootPath);
    const records: PresetRecord[] = [];
    const probeResults: FilePresetProbeResult[] = [];

    for (const absoluteFilePath of presetFiles) {
      const relativePath = toRelativePresetPath(absoluteRootPath, absoluteFilePath);
      const stats = fs.statSync(absoluteFilePath);
      const baseRecord = createMetadataOnlyRecord(relativePath, stats, {
        includeModifiedTime: this.includeModifiedTime,
        includeSizeBytes: this.includeSizeBytes,
      });

      const probeResult = this.parseProbeEnabled
        ? runParseProbe(absoluteFilePath, relativePath, this.parseProbeMaxBytes)
        : { relativePath, status: "disabled" as const };

      const mergedRecord = probeResult.status === "parsed"
        ? mergeParsedMetadata(baseRecord, probeResult.extractedFields ?? [], probeResult.detail)
        : baseRecord;

      records.push(derivePresetLabels(mergedRecord));
      probeResults.push(probeResult);
    }

    return { records, probeResults };
  }
}

function walkPresetFiles(rootPath: string): string[] {
  const files: string[] = [];
  walkDirectory(rootPath, files);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function walkDirectory(currentPath: string, files: string[]): void {
  const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absoluteEntryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(absoluteEntryPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== DEFAULT_PRESET_FILE_EXTENSION.toLowerCase()) continue;
    files.push(absoluteEntryPath);
  }
}

function createMetadataOnlyRecord(
  relativePath: string,
  stats: fs.Stats,
  options: { includeModifiedTime: boolean; includeSizeBytes: boolean },
): PresetRecord {
  const fileName = path.posix.basename(relativePath);
  const extension = path.posix.extname(fileName) || DEFAULT_PRESET_FILE_EXTENSION;
  const metadataTraits = buildMetadataTraits(relativePath);
  const fileMetadata: PresetRecord["file"] = {
    relativePath,
    fileName,
    extension,
  };

  if (options.includeSizeBytes) fileMetadata.sizeBytes = stats.size;
  if (options.includeModifiedTime) fileMetadata.modifiedIso = stats.mtime.toISOString();

  const record: PresetRecord = {
    schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
    id: createRecordId(relativePath),
    file: fileMetadata,
    source: { kind: "filename" },
    provenance: [
      {
        kind: "derived_from_filename",
        path: "file.relativePath",
        detail: "metadata-only file scan",
      },
      {
        kind: "fixture",
        path: "file.relativePath",
        detail: "synthetic fixture-compatible file source",
      },
    ],
  };

  if (metadataTraits) record.metadataTraits = metadataTraits;
  return record;
}

function buildMetadataTraits(relativePath: string): MetadataTraits | undefined {
  const directorySegments = path.posix.dirname(relativePath) === "."
    ? []
    : path.posix.dirname(relativePath).split("/").filter(Boolean);
  const fileStem = stripExtension(path.posix.basename(relativePath));
  const tags = uniqueStrings([...directorySegments, ...tokenize(fileStem)]);
  const categoryHint = directorySegments[0] ?? findCategoryToken([...directorySegments, ...tokenize(fileStem)]);

  if (directorySegments.length === 0 && tags.length === 0 && !categoryHint) return undefined;

  const result: MetadataTraits = {
    provenance: [
      {
        kind: "derived_from_filename",
        path: "file.relativePath",
        detail: "folder and filename metadata hints",
      },
    ],
  };

  if (directorySegments[0]) result.bank = directorySegments[0];
  if (categoryHint) result.category = categoryHint;
  if (directorySegments[1]) result.style = directorySegments[1];
  if (tags.length > 0) result.tags = tags;
  return result;
}

function findCategoryToken(tokens: string[]): string | undefined {
  for (const token of tokens) {
    if (token.length === 0) continue;
    return token;
  }
  return undefined;
}

function tokenize(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function stripExtension(fileName: string): string {
  return fileName.endsWith(DEFAULT_PRESET_FILE_EXTENSION)
    ? fileName.slice(0, -DEFAULT_PRESET_FILE_EXTENSION.length)
    : fileName.replace(/\.[^.]+$/, "");
}

function createRecordId(relativePath: string): string {
  const digest = crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  return `file.${digest}`;
}

function toRelativePresetPath(rootPath: string, absoluteFilePath: string): string {
  return path.relative(rootPath, absoluteFilePath).split(path.sep).join(path.posix.sep);
}

function runParseProbe(absoluteFilePath: string, relativePath: string, maxBytes: number): FilePresetProbeResult {
  const fileHandle = fs.openSync(absoluteFilePath, "r");

  try {
    const stats = fs.fstatSync(fileHandle);
    const bytesToRead = Math.min(stats.size, maxBytes);
    const boundedBuffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = bytesToRead > 0 ? fs.readSync(fileHandle, boundedBuffer, 0, bytesToRead, 0) : 0;
    const probeBuffer = boundedBuffer.subarray(0, bytesRead);
    const headerIndex = probeBuffer.indexOf(XFER_JSON_HEADER);

    if (headerIndex < 0) {
      return {
        relativePath,
        status: "header_missing",
        detail: `no ${XFER_JSON_HEADER} header detected in first ${probeBuffer.length} bytes`,
      };
    }

    const payloadOffset = headerIndex + XFER_JSON_HEADER.length;
    const payload = probeBuffer.subarray(payloadOffset).toString("utf8").replace(/^\0+/, "").trim();

    if (payload.length === 0) {
      return {
        relativePath,
        status: "parse_failed",
        detail: `${XFER_JSON_HEADER} header found but JSON payload is empty`,
      };
    }

    try {
      const parsed = JSON.parse(payload);
      if (!isRecord(parsed)) {
        return {
          relativePath,
          status: "parse_failed",
          detail: `${XFER_JSON_HEADER} payload is not a JSON object`,
        };
      }

      const extractedFields = extractSafeMetadataFields(parsed);
      return {
        relativePath,
        status: "parsed",
        detail: `${XFER_JSON_HEADER} header parsed within ${probeBuffer.length} bytes`,
        extractedFields,
      };
    } catch (error) {
      return {
        relativePath,
        status: "parse_failed",
        detail: `${XFER_JSON_HEADER} payload parse failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } finally {
    fs.closeSync(fileHandle);
  }
}

function extractSafeMetadataFields(value: Record<string, unknown>): string[] {
  const safeFields = ["author", "vendor", "bank", "category", "style", "tags"];
  return safeFields.filter((field) => field in value);
}

function mergeParsedMetadata(record: PresetRecord, extractedFields: string[], detail?: string): PresetRecord {
  if (extractedFields.length === 0 && !detail) return record;

  const tags = uniqueStrings([...(record.metadataTraits?.tags ?? []), ...extractedFields.map((field) => `probe:${field}`)]);
  const metadataTraits: MetadataTraits = {
    ...(record.metadataTraits ?? {}),
    provenance: [
      ...((record.metadataTraits?.provenance ?? []).slice()),
      {
        kind: "derived_from_filename",
        path: "file.relativePath",
        detail: detail ?? "bounded parse probe executed",
      },
    ],
  };

  if (tags.length > 0) metadataTraits.tags = tags;

  return {
    ...record,
    metadataTraits,
  };
}

function validateProbeByteLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`parseProbe.maxBytes must be a positive number, got ${String(value)}`);
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
