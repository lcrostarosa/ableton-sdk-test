const ACQUISITION_GATE_STATUSES = ["PASS", "FAIL", "SKIPPED", "UNKNOWN"] as const;

const ACQUISITION_CAPABILITIES = [
  {
    id: "serum-preset-metadata-parse",
    name: ".SerumPreset metadata parse",
  },
  {
    id: "ableton-device-parameter-snapshot",
    name: "Ableton device parameter snapshot",
  },
  {
    id: "ableton-audio-render-capture",
    name: "Audio-track render capture",
  },
  {
    id: "manual-current-preset-capture",
    name: "Manual/current-preset capture",
  },
  {
    id: "max-for-live-preset-probe",
    name: "Max for Live preset probe",
  },
] as const;

export type AcquisitionGateStatus = typeof ACQUISITION_GATE_STATUSES[number];
export type AcquisitionCapability = typeof ACQUISITION_CAPABILITIES[number];
export type AcquisitionCapabilityId = AcquisitionCapability["id"];
export type AcquisitionCapturePath =
  | "max_for_live_preset_probe"
  | "manual_current_preset"
  | "metadata_only"
  | "unavailable";
export type AcquisitionMetadataPath =
  | "serum_preset_metadata"
  | "filename_folder_metadata"
  | "unavailable";

export interface AcquisitionGateResult {
  capabilityId: AcquisitionCapabilityId;
  capabilityName: string;
  status: AcquisitionGateStatus;
  reason: string;
  evidencePath?: string;
  details?: string;
}

export interface AcquisitionFeatureAvailability {
  filenameMetadata: boolean;
  parsedPresetMetadata: boolean;
  parameters: boolean;
  audio: boolean;
  parameterSimilarity: boolean;
  audioSimilarity: boolean;
  audioFeaturesMissing: boolean;
  parameterFeaturesMissing: boolean;
}

export interface AcquisitionFallbackSelection {
  capturePath: AcquisitionCapturePath;
  metadataPath: AcquisitionMetadataPath;
  featureSources: string[];
  featureAvailability: AcquisitionFeatureAvailability;
  notes: string[];
}

export interface AcquisitionGateReport {
  filenameMetadataAvailable: boolean;
  gateResults: AcquisitionGateResult[];
  fallbackSelection: AcquisitionFallbackSelection;
}

export interface EvaluateAcquisitionGateInput {
  filenameMetadataAvailable: boolean;
  gateResults: AcquisitionGateResult[];
}

export function createAcquisitionGateResult(input: {
  capabilityId: AcquisitionCapabilityId;
  status: AcquisitionGateStatus;
  reason: string;
  evidencePath?: string;
  details?: string;
}): AcquisitionGateResult {
  const capability = capabilityById(input.capabilityId);
  const evidencePath = optionalNonEmpty(input.evidencePath, `${capability.id}.evidencePath`);
  const details = optionalNonEmpty(input.details, `${capability.id}.details`);
  return {
    capabilityId: capability.id,
    capabilityName: capability.name,
    status: expectStatus(input.status),
    reason: expectNonEmpty(input.reason, `${capability.id}.reason`),
    ...(evidencePath === undefined ? {} : { evidencePath }),
    ...(details === undefined ? {} : { details }),
  };
}

export function evaluateAcquisitionGates(input: EvaluateAcquisitionGateInput): AcquisitionGateReport {
  const gateResults = ACQUISITION_CAPABILITIES.map((capability) => {
    const found = input.gateResults.find((result) => result.capabilityId === capability.id);
    return found
      ? normalizeGateResult(found)
      : createAcquisitionGateResult({
          capabilityId: capability.id,
          status: "UNKNOWN",
          reason: `No fixture result supplied for ${capability.name}.`,
        });
  });

  const parseGate = getGateResult(gateResults, "serum-preset-metadata-parse");
  const parameterGate = getGateResult(gateResults, "ableton-device-parameter-snapshot");
  const audioGate = getGateResult(gateResults, "ableton-audio-render-capture");
  const manualGate = getGateResult(gateResults, "manual-current-preset-capture");
  const maxForLiveGate = getGateResult(gateResults, "max-for-live-preset-probe");

  const metadataPath: AcquisitionMetadataPath =
    parseGate.status === "PASS"
      ? "serum_preset_metadata"
      : input.filenameMetadataAvailable
        ? "filename_folder_metadata"
        : "unavailable";

  const capturePath = selectCapturePath({
    metadataPath,
    manualGate,
    maxForLiveGate,
  });

  const parametersAvailable = capturePath !== "metadata_only" && capturePath !== "unavailable" && parameterGate.status === "PASS";
  const audioAvailable = capturePath !== "metadata_only" && capturePath !== "unavailable" && audioGate.status === "PASS";

  const featureSources: string[] = [];
  if (metadataPath === "serum_preset_metadata") {
    featureSources.push("serum-preset-metadata");
  } else if (metadataPath === "filename_folder_metadata") {
    featureSources.push("filename-folder-metadata");
  }
  if (parametersAvailable) featureSources.push("ableton-parameter-snapshot");
  if (audioAvailable) featureSources.push("ableton-audio-render");

  const notes = buildNotes({
    filenameMetadataAvailable: input.filenameMetadataAvailable,
    metadataPath,
    capturePath,
    parameterGate,
    parametersAvailable,
    audioGate,
    audioAvailable,
    parseGate,
    maxForLiveGate,
  });

  return {
    filenameMetadataAvailable: input.filenameMetadataAvailable,
    gateResults,
    fallbackSelection: {
      capturePath,
      metadataPath,
      featureSources,
      featureAvailability: {
        filenameMetadata: input.filenameMetadataAvailable,
        parsedPresetMetadata: parseGate.status === "PASS",
        parameters: parametersAvailable,
        audio: audioAvailable,
        parameterSimilarity: parametersAvailable,
        audioSimilarity: audioAvailable,
        audioFeaturesMissing: !audioAvailable,
        parameterFeaturesMissing: !parametersAvailable,
      },
      notes,
    },
  };
}

export function formatAcquisitionGateReportMarkdown(report: AcquisitionGateReport): string {
  const lines: string[] = [
    "# Acquisition Gate Report",
    "",
    `Filename metadata available: ${report.filenameMetadataAvailable ? "YES" : "NO"}`,
    "",
    "## Gates",
    "",
    "| Capability ID | Capability | Status | Reason | Evidence | Details |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const gate of report.gateResults) {
    lines.push(
      `| ${gate.capabilityId} | ${gate.capabilityName} | ${gate.status} | ${escapeCell(gate.reason)} | ${escapeCell(gate.evidencePath ?? "-")} | ${escapeCell(gate.details ?? "-")} |`
    );
  }

  lines.push(
    "",
    "## Fallback Selection",
    "",
    `- Capture path: ${describeCapturePath(report.fallbackSelection.capturePath)}`,
    `- Metadata path: ${describeMetadataPath(report.fallbackSelection.metadataPath)}`,
    `- Feature sources: ${report.fallbackSelection.featureSources.length > 0 ? report.fallbackSelection.featureSources.join(", ") : "none"}`,
    `- Parameter similarity: ${report.fallbackSelection.featureAvailability.parameterSimilarity ? "enabled" : "disabled"}`,
    `- Audio similarity: ${report.fallbackSelection.featureAvailability.audioSimilarity ? "enabled" : "disabled"}`,
    `- Audio features missing: ${report.fallbackSelection.featureAvailability.audioFeaturesMissing ? "YES" : "NO"}`,
    `- Parameter features missing: ${report.fallbackSelection.featureAvailability.parameterFeaturesMissing ? "YES" : "NO"}`,
    "",
    "## Notes",
    ""
  );

  for (const note of report.fallbackSelection.notes) {
    lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

export function formatFallbackSummary(report: AcquisitionGateReport): string {
  const summary: string[] = [
    `capture=${report.fallbackSelection.capturePath}`,
    `metadata=${report.fallbackSelection.metadataPath}`,
    `parameterSimilarity=${report.fallbackSelection.featureAvailability.parameterSimilarity ? "yes" : "no"}`,
    `audioSimilarity=${report.fallbackSelection.featureAvailability.audioSimilarity ? "yes" : "no"}`,
    `featureSources=${report.fallbackSelection.featureSources.length > 0 ? report.fallbackSelection.featureSources.join(",") : "none"}`,
  ];
  for (const note of report.fallbackSelection.notes) {
    summary.push(`note=${note}`);
  }
  return summary.join("\n") + "\n";
}

function buildNotes(input: {
  filenameMetadataAvailable: boolean;
  metadataPath: AcquisitionMetadataPath;
  capturePath: AcquisitionCapturePath;
  parameterGate: AcquisitionGateResult;
  parametersAvailable: boolean;
  audioGate: AcquisitionGateResult;
  audioAvailable: boolean;
  parseGate: AcquisitionGateResult;
  maxForLiveGate: AcquisitionGateResult;
}): string[] {
  const notes: string[] = [];

  if (input.maxForLiveGate.status !== "PASS" && input.capturePath === "manual_current_preset") {
    notes.push("Automatic preset enumeration/loading is unavailable, so manual/current-preset capture is selected.");
  }
  if (input.parseGate.status !== "PASS" && input.metadataPath === "filename_folder_metadata") {
    notes.push("Direct .SerumPreset parsing is unavailable, so indexing falls back to filename/folder metadata only.");
  }
  if (!input.audioAvailable) {
    notes.push(`Audio render is unavailable for this path (${input.audioGate.status}: ${input.audioGate.reason}), so audio features are marked missing.`);
  }
  if (!input.parametersAvailable) {
    notes.push(`Parameter snapshot is unavailable for this path (${input.parameterGate.status}: ${input.parameterGate.reason}), so parameter similarity is disabled.`);
  }
  if (input.capturePath === "metadata_only") {
    notes.push("No automatic or manual capture path is available, so indexing degrades to metadata-only.");
  }
  if (input.capturePath === "unavailable") {
    notes.push("No metadata or capture path is available, so acquisition remains unavailable.");
  }
  if (!input.filenameMetadataAvailable && input.metadataPath === "unavailable") {
    notes.push("Filename/folder metadata is also unavailable.");
  }

  return notes;
}

function selectCapturePath(input: {
  metadataPath: AcquisitionMetadataPath;
  manualGate: AcquisitionGateResult;
  maxForLiveGate: AcquisitionGateResult;
}): AcquisitionCapturePath {
  if (input.maxForLiveGate.status === "PASS") return "max_for_live_preset_probe";
  if (input.manualGate.status === "PASS") return "manual_current_preset";
  if (input.metadataPath !== "unavailable") return "metadata_only";
  return "unavailable";
}

function getGateResult(gateResults: AcquisitionGateResult[], capabilityId: AcquisitionCapabilityId): AcquisitionGateResult {
  const found = gateResults.find((gate) => gate.capabilityId === capabilityId);
  if (!found) {
    throw new Error(`Missing acquisition gate result for ${capabilityId}.`);
  }
  return found;
}

function normalizeGateResult(result: AcquisitionGateResult): AcquisitionGateResult {
  const capability = capabilityById(result.capabilityId);
  const evidencePath = optionalNonEmpty(result.evidencePath, `${capability.id}.evidencePath`);
  const details = optionalNonEmpty(result.details, `${capability.id}.details`);
  return {
    capabilityId: capability.id,
    capabilityName: capability.name,
    status: expectStatus(result.status),
    reason: expectNonEmpty(result.reason, `${capability.id}.reason`),
    ...(evidencePath === undefined ? {} : { evidencePath }),
    ...(details === undefined ? {} : { details }),
  };
}

function capabilityById(capabilityId: AcquisitionCapabilityId): AcquisitionCapability {
  const capability = ACQUISITION_CAPABILITIES.find((item) => item.id === capabilityId);
  if (!capability) {
    throw new Error(`Unsupported acquisition capability: ${capabilityId}`);
  }
  return capability;
}

function expectStatus(status: AcquisitionGateStatus): AcquisitionGateStatus {
  if (ACQUISITION_GATE_STATUSES.includes(status)) return status;
  throw new Error(`Unsupported acquisition gate status: ${String(status)}`);
}

function expectNonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmpty(value: string | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  return expectNonEmpty(value, path);
}

function describeCapturePath(capturePath: AcquisitionCapturePath): string {
  switch (capturePath) {
    case "max_for_live_preset_probe":
      return "automatic preset probe";
    case "manual_current_preset":
      return "manual/current-preset capture";
    case "metadata_only":
      return "metadata-only indexing";
    case "unavailable":
      return "unavailable";
  }
}

function describeMetadataPath(metadataPath: AcquisitionMetadataPath): string {
  switch (metadataPath) {
    case "serum_preset_metadata":
      return ".SerumPreset metadata";
    case "filename_folder_metadata":
      return "filename/folder metadata";
    case "unavailable":
      return "unavailable";
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
