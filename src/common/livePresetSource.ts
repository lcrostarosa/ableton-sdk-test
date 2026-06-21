import path from "node:path";
import { formatFallbackSummary, type AcquisitionGateReport, type AcquisitionGateResult } from "./acquisitionGates.ts";
import {
  PRESET_CORPUS_SCHEMA_VERSION,
  type ParameterSnapshot,
  type PresetRecord,
  validatePresetRecord,
} from "./presetCorpus.ts";
import { derivePresetLabels } from "./presetLabels.ts";
import { resolveDevice, type SdkDevice, type SdkDeviceParameter, type SdkTrack } from "./liveAdapter.ts";

export interface LiveDevicePresetSourceOptions {
  defaultDeviceMatch?: string;
}

export interface LivePresetManualMetadata {
  author?: string;
  config?: string;
  notes?: string;
  sourceName?: string;
}

export interface CaptureLivePresetOptions {
  track: SdkTrack;
  presetName: string;
  deviceMatch?: string;
  manual?: LivePresetManualMetadata;
  gateReport?: AcquisitionGateReport;
  renderReference?: string;
  capturedAt?: string;
}

export class LiveDevicePresetSource {
  private readonly defaultDeviceMatch: string;

  constructor(options: LiveDevicePresetSourceOptions = {}) {
    this.defaultDeviceMatch = normalizeRequiredString(options.defaultDeviceMatch ?? "serum", "defaultDeviceMatch");
  }

  async capture(options: CaptureLivePresetOptions): Promise<PresetRecord> {
    const track = options.track;
    const presetName = normalizeRequiredString(options.presetName, "presetName");
    const deviceMatch = normalizeRequiredString(options.deviceMatch ?? this.defaultDeviceMatch, "deviceMatch");
    const device = resolveDevice(track, deviceMatch);
    const capturedAt = normalizeOptionalString(options.capturedAt) ?? new Date().toISOString();
    const manual = options.manual;
    const parameters = await captureParameters(device);
    const relativePath = buildRelativePath(track.name, device.name, presetName);
    const fileName = path.posix.basename(relativePath);

    const provenance = [
      {
        kind: "manual" as const,
        path: "source.ableton.presetName",
        detail: `Captured the currently loaded preset from Ableton track ${JSON.stringify(track.name)} and device ${JSON.stringify(device.name)}.`,
        at: capturedAt,
      },
      ...buildGateProvenance(options.gateReport, capturedAt),
      ...buildManualProvenance(manual, options.renderReference, capturedAt),
    ];

    const source: PresetRecord["source"] = {
      kind: "ableton",
      synth: device.name,
      ableton: {
        trackName: track.name,
        deviceName: device.name,
        pluginName: device.name,
        presetName,
      },
    };

    if (manual) source.manual = buildManualMetadata(manual, options.renderReference);

    const record: PresetRecord = {
      schemaVersion: PRESET_CORPUS_SCHEMA_VERSION,
      id: buildRecordId(track.name, device.name, presetName),
      file: {
        relativePath,
        fileName,
        extension: path.posix.extname(fileName) || ".json",
      },
      source,
      provenance,
      ...(parameters.length > 0 ? { parameters } : {}),
    };

    return derivePresetLabels(record);
  }
}

async function captureParameters(device: SdkDevice): Promise<ParameterSnapshot[]> {
  const parameters = device.parameters ?? [];
  const snapshots: ParameterSnapshot[] = [];

  for (const parameter of parameters) {
    const snapshot = await toParameterSnapshot(parameter);
    if (snapshot) snapshots.push(snapshot);
  }

  return snapshots;
}

async function toParameterSnapshot(parameter: SdkDeviceParameter): Promise<ParameterSnapshot | undefined> {
  const id = slugify(parameter.name);
  if (id.length === 0) return undefined;

  let rawValue: number | undefined;
  try {
    rawValue = await parameter.getValue();
  } catch {
    rawValue = undefined;
  }

  const snapshot: ParameterSnapshot = {
    id,
    name: parameter.name,
    provenance: [
      {
        kind: "derived_from_parameters",
        path: `device.parameters.${id}`,
        detail: rawValue === undefined
          ? "Parameter was exposed but did not return a readable value during current-preset capture."
          : "Captured from Ableton device.parameters during current-preset capture.",
      },
    ],
  };

  if (rawValue !== undefined) snapshot.value = rawValue;

  const normalizedValue = normalizeParameterValue(rawValue, parameter.min, parameter.max);
  if (normalizedValue !== undefined) snapshot.normalizedValue = normalizedValue;

  return snapshot;
}

function normalizeParameterValue(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
  return clamp01((value - min) / (max - min));
}

function buildRelativePath(trackName: string, deviceName: string, presetName: string): string {
  return path.posix.join(
    "ableton",
    slugify(trackName) || "track",
    `${slugify(deviceName) || "device"}__${slugify(presetName) || "preset"}.json`,
  );
}

function buildRecordId(trackName: string, deviceName: string, presetName: string): string {
  return ["live", slugify(trackName), slugify(deviceName), slugify(presetName)]
    .filter((segment) => segment.length > 0)
    .join(".");
}

function buildManualMetadata(
  manual: LivePresetManualMetadata,
  renderReference: string | undefined,
): NonNullable<PresetRecord["source"]["manual"]> {
  const notes = [normalizeOptionalString(manual.config), normalizeOptionalString(manual.notes)]
    .filter((value): value is string => value !== undefined);

  if (renderReference) notes.push(`renderReference=${renderReference}`);

  const result: NonNullable<PresetRecord["source"]["manual"]> = {};
  const author = normalizeOptionalString(manual.author);
  const sourceName = normalizeOptionalString(manual.sourceName);

  if (author) result.author = author;
  if (sourceName) result.sourceName = sourceName;
  if (notes.length > 0) result.notes = notes.join("\n");
  return result;
}

function buildGateProvenance(gateReport: AcquisitionGateReport | undefined, capturedAt: string) {
  if (!gateReport) return [];

  const entries = gateReport.gateResults.map((gate) => gateToProvenance(gate, capturedAt));
  entries.push({
    kind: "manual" as const,
    path: "acquisitionGates.fallbackSelection",
    detail: formatFallbackSummary(gateReport).trim(),
    at: capturedAt,
  });
  return entries;
}

function gateToProvenance(gate: AcquisitionGateResult, capturedAt: string) {
  const detailParts = [
    `status=${gate.status}`,
    `reason=${gate.reason}`,
    gate.details ? `details=${gate.details}` : undefined,
    gate.evidencePath ? `evidence=${gate.evidencePath}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return {
    kind: "manual" as const,
    path: `acquisitionGates.${gate.capabilityId}`,
    detail: detailParts.join(" | "),
    at: capturedAt,
  };
}

function buildManualProvenance(manual: LivePresetManualMetadata | undefined, renderReference: string | undefined, capturedAt: string) {
  const details: string[] = [];
  if (manual) {
    const config = normalizeOptionalString(manual.config);
    const notes = normalizeOptionalString(manual.notes);
    const sourceName = normalizeOptionalString(manual.sourceName);
    const author = normalizeOptionalString(manual.author);
    if (sourceName) details.push(`sourceName=${sourceName}`);
    if (author) details.push(`author=${author}`);
    if (config) details.push(`config=${config}`);
    if (notes) details.push(`notes=${notes}`);
  }
  if (renderReference) details.push(`renderReference=${renderReference}`);
  if (details.length === 0) return [];

  return [{
    kind: "manual" as const,
    path: "source.manual",
    detail: details.join(" | "),
    at: capturedAt,
  }];
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
