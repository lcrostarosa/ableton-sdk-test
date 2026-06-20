import {
  type AudioFeatureVector,
  type ParameterSnapshot,
  PRESET_CORPUS_SCHEMA_VERSION,
  type PresetRecord,
  type Provenance,
  type ProvenanceKind,
  type RoleLabel,
  type TraitLabel,
  validatePresetRecord,
} from "./presetCorpus.ts";

interface LabelAccumulator<TLabel> {
  label: TLabel;
  provenances: Provenance[];
  strengths: number[];
}

interface TextHintSource {
  text: string;
  tokens: Set<string>;
  kind: ProvenanceKind;
  path: string;
}

interface RoleHintDefinition {
  role: RoleLabel["role"];
  aliases: string[];
  confidence: number;
}

interface TraitHintDefinition {
  trait: TraitLabel["trait"];
  value: NonNullable<TraitLabel["value"]>;
  aliases: string[];
}

const ROLE_HINTS: readonly RoleHintDefinition[] = [
  { role: "bass", aliases: ["bass", "sub", "808", "reese"], confidence: 0.93 },
  { role: "lead", aliases: ["lead", "ld", "hook", "solo", "mono"], confidence: 0.9 },
  { role: "pad", aliases: ["pad", "pd", "wash", "chord"], confidence: 0.9 },
  { role: "pluck", aliases: ["pluck", "plk", "plucked", "mallet", "kalimba"], confidence: 0.9 },
  { role: "keys", aliases: ["keys", "key", "piano", "ep", "rhodes", "organ", "clav", "bell"], confidence: 0.9 },
  { role: "fx", aliases: ["fx", "sfx", "riser", "downlifter", "impact", "sweep", "hit"], confidence: 0.92 },
  { role: "arp", aliases: ["arp", "arpeggio", "seq", "sequence", "sequenced"], confidence: 0.92 },
  { role: "atmosphere", aliases: ["atmos", "atmosphere", "ambient", "drone", "texture"], confidence: 0.9 },
  { role: "percussion", aliases: ["perc", "percussion", "drum", "kick", "snare", "clap", "hat", "tom", "shaker"], confidence: 0.93 },
];

const TEXT_TRAIT_HINTS: readonly TraitHintDefinition[] = [
  { trait: "brightness", value: "dark", aliases: ["warm", "dark", "muted"] },
  { trait: "brightness", value: "bright", aliases: ["bright", "air", "airy", "sparkle"] },
  { trait: "bass_weight", value: "heavy", aliases: ["sub", "bass", "low", "weight"] },
  { trait: "intensity", value: "aggressive", aliases: ["aggressive", "hard", "distorted", "gnarly"] },
  { trait: "intensity", value: "soft", aliases: ["soft", "gentle", "smooth"] },
  { trait: "noisiness", value: "noisy", aliases: ["noisy", "noise", "hiss", "grit"] },
  { trait: "movement", value: "moving", aliases: ["moving", "motion", "animated", "evolving"] },
  { trait: "articulation", value: "plucked", aliases: ["pluck", "plucked", "pick"] },
  { trait: "articulation", value: "sustained", aliases: ["sustain", "sustained", "strings", "legato"] },
];

export function derivePresetLabels(record: PresetRecord): PresetRecord {
  const baseRecord = validatePresetRecord(record);
  const traitLabels = deriveTraitLabels(baseRecord);
  const roleLabels = deriveRoleLabels(baseRecord, traitLabels);

  const labeledRecord: PresetRecord = {
    ...baseRecord,
    ...(traitLabels.length > 0 ? { traitLabels } : {}),
    ...(roleLabels.length > 0 ? { roleLabels } : {}),
  };

  if (traitLabels.length === 0) delete labeledRecord.traitLabels;
  if (roleLabels.length === 0) delete labeledRecord.roleLabels;
  return validatePresetRecord(labeledRecord);
}

export function deriveTraitLabels(record: PresetRecord): TraitLabel[] {
  const map = new Map<string, LabelAccumulator<TraitLabel>>();

  deriveHintTraitLabels(record).forEach((label) => addTraitLabel(map, label));
  deriveAudioTraitLabels(record.audioFeatures).forEach((label) => addTraitLabel(map, label));
  deriveParameterTraitLabels(record.parameters).forEach((label) => addTraitLabel(map, label));

  return [...map.values()]
    .map(({ label, provenances, strengths }) => ({
      ...label,
      confidence: combineConfidence(strengths),
      provenance: dedupeProvenance(provenances),
    }))
    .sort(compareTraitLabels);
}

export function deriveRoleLabels(record: PresetRecord, traitLabels = deriveTraitLabels(record)): RoleLabel[] {
  const map = new Map<string, LabelAccumulator<RoleLabel>>();

  deriveHintRoleLabels(record).forEach((label) => addRoleLabel(map, label));
  deriveAudioRoleLabels(record.audioFeatures, traitLabels).forEach((label) => addRoleLabel(map, label));

  if (map.size === 0) {
    addRoleLabel(map, {
      role: "other",
      confidence: 0.24,
      provenance: [
        {
          kind: "derived_from_filename",
          path: "file.relativePath",
          confidence: 0.24,
          detail: "Label derivation v1 found no explicit filename, manual, or audio role hints above threshold, so it falls back to role=other.",
        },
      ],
    });
  }

  return [...map.values()]
    .map(({ label, provenances, strengths }) => ({
      ...label,
      confidence: combineConfidence(strengths),
      provenance: dedupeProvenance(provenances),
    }))
    .sort(compareRoleLabels);
}

function deriveHintRoleLabels(record: PresetRecord): RoleLabel[] {
  const labels: RoleLabel[] = [];
  const sources = collectHintSources(record);
  const textOnlyFallback = isTextOnlyFallback(record);

  for (const source of sources) {
    for (const hint of ROLE_HINTS) {
      const matches = hint.aliases.filter((alias) => source.tokens.has(alias));
      if (matches.length === 0) continue;
      const confidence = textOnlyFallback
        ? lowConfidenceForTextHint(source.kind, matches.length)
        : clamp01(hint.confidence + (matches.length > 1 ? 0.03 : 0));
      labels.push({
        role: hint.role,
        confidence,
        provenance: [
          {
            kind: source.kind,
            path: source.path,
            confidence,
            detail: `Label derivation v1 inferred role=${hint.role} from tokens [${matches.join(", ")}] in ${JSON.stringify(source.text)}.`,
          },
        ],
      });
    }
  }

  return labels;
}

function deriveHintTraitLabels(record: PresetRecord): TraitLabel[] {
  const labels: TraitLabel[] = [];
  const sources = collectHintSources(record);

  for (const source of sources) {
    for (const hint of TEXT_TRAIT_HINTS) {
      const matches = hint.aliases.filter((alias) => source.tokens.has(alias));
      if (matches.length === 0) continue;
      const confidence = lowConfidenceForTextHint(source.kind, matches.length);
      labels.push({
        trait: hint.trait,
        value: hint.value,
        confidence,
        provenance: [
          {
            kind: source.kind,
            path: source.path,
            confidence,
            detail: `Label derivation v1 inferred ${hint.trait}=${hint.value} from text tokens [${matches.join(", ")}] in ${JSON.stringify(source.text)}.`,
          },
        ],
      });
    }
  }

  return labels;
}

function deriveAudioRoleLabels(
  audioFeatures: AudioFeatureVector | undefined,
  traitLabels: readonly TraitLabel[],
): RoleLabel[] {
  if (!audioFeatures) return [];

  const labels: RoleLabel[] = [];
  const bassHeavy = hasTrait(traitLabels, "bass_weight", "heavy");
  const bright = hasTrait(traitLabels, "brightness", "bright");
  const aggressive = hasTrait(traitLabels, "intensity", "aggressive");
  const moving = hasTrait(traitLabels, "movement", "moving");
  const noisy = hasTrait(traitLabels, "noisiness", "noisy");
  const plucked = hasTrait(traitLabels, "articulation", "plucked");
  const sustained = hasTrait(traitLabels, "articulation", "sustained");
  const bassRatio = audioFeatures.bassRatio ?? 0;
  const highRatio = audioFeatures.highRatio ?? 0;
  const centroid = audioFeatures.centroid ?? 0;
  const flux = getFeature(audioFeatures, "flux");

  if (bassHeavy && bassRatio >= 0.42 && highRatio <= 0.4) {
    const confidence = clamp01(0.58 + bassRatio * 0.28 + (highRatio <= 0.22 ? 0.06 : 0));
    labels.push(makeAudioRole("bass", confidence, `bassRatio=${formatMetric(bassRatio)} and highRatio=${formatMetric(highRatio)} suggest a bass-focused register.`));
  }

  if (bright && aggressive && centroid >= 1200) {
    const confidence = clamp01(0.54 + Math.max(audioFeatures.highRatio ?? 0, 0) * 0.2 + (centroid >= 2200 ? 0.08 : 0));
    labels.push(makeAudioRole("lead", confidence, `brightness and intensity crossed thresholds with centroid=${formatMetric(centroid)}Hz, which fits a lead-like foreground timbre.`));
  }

  if (moving && plucked) {
    const confidence = clamp01(0.56 + flux * 0.18);
    labels.push(makeAudioRole("arp", confidence, `movement and plucked articulation were inferred from audio metrics, which fits an arp role.`));
  }

  if (noisy && moving) {
    const confidence = clamp01(0.55 + getFeature(audioFeatures, "spectralFlatness") * 0.2 + flux * 0.1);
    labels.push(makeAudioRole("fx", confidence, `noisiness and movement exceeded thresholds, which fits an FX-style preset.`));
  }

  if (sustained && flux <= 0.18) {
    const confidence = clamp01(0.54 + (1 - flux) * 0.12);
    labels.push(makeAudioRole("pad", confidence, `sustained articulation with low movement suggests a pad role.`));
  }

  if (sustained && noisy) {
    const confidence = clamp01(0.52 + getFeature(audioFeatures, "spectralFlatness") * 0.18);
    labels.push(makeAudioRole("atmosphere", confidence, `sustained articulation plus measurable noisiness suggests an atmosphere layer.`));
  }

  return labels;
}

function deriveAudioTraitLabels(audioFeatures: AudioFeatureVector | undefined): TraitLabel[] {
  if (!audioFeatures) return [];

  const labels: TraitLabel[] = [];
  const highRatio = audioFeatures.highRatio;
  const centroid = audioFeatures.centroid;
  const bassRatio = audioFeatures.bassRatio;
  const rms = audioFeatures.rms;
  const flux = getFeature(audioFeatures, "flux");
  const spectralFlatness = getFeature(audioFeatures, "spectralFlatness");
  const envelopeSustainRatio = getFeature(audioFeatures, "envelopeSustainRatio");
  const envelopeDecayRatio = getFeature(audioFeatures, "envelopeDecayRatio");
  const attackSeconds = getFeature(audioFeatures, "attackSeconds");

  const brightScore = Math.max(scale(highRatio, 0.42, 0.68), scale(centroid, 1400, 3200));
  if (brightScore >= 0.35) {
    const confidence = clamp01(0.54 + brightScore * 0.32);
    labels.push(makeAudioTrait("brightness", "bright", confidence, `highRatio=${formatMetric(highRatio)} and centroid=${formatMetric(centroid)}Hz indicate above-threshold brightness.`));
  }

  const darkScore = Math.max(scaleInverse(highRatio, 0.2, 0.34), scaleInverse(centroid, 650, 1200));
  if (darkScore >= 0.5) {
    const confidence = clamp01(0.5 + darkScore * 0.26);
    labels.push(makeAudioTrait("brightness", "dark", confidence, `highRatio=${formatMetric(highRatio)} and centroid=${formatMetric(centroid)}Hz stayed below the bright thresholds.`));
  }

  const bassHeavyScore = scale(bassRatio, 0.28, 0.62);
  if (bassHeavyScore >= 0.4) {
    const confidence = clamp01(0.55 + bassHeavyScore * 0.28);
    labels.push(makeAudioTrait("bass_weight", "heavy", confidence, `bassRatio=${formatMetric(bassRatio)} indicates elevated low-frequency weight.`));
  }

  const aggressiveScore = Math.max(scale(rms, 0.18, 0.42), scale(highRatio, 0.38, 0.72));
  if (aggressiveScore >= 0.45) {
    const confidence = clamp01(0.5 + aggressiveScore * 0.3);
    labels.push(makeAudioTrait("intensity", "aggressive", confidence, `rms=${formatMetric(rms)} and highRatio=${formatMetric(highRatio)} crossed the intensity thresholds.`));
  }

  if (flux > 0) {
    const movementScore = scale(flux, 0.12, 0.42);
    if (movementScore >= 0.45) {
      const confidence = clamp01(0.48 + movementScore * 0.28);
      labels.push(makeAudioTrait("movement", "moving", confidence, `features.flux=${formatMetric(flux)} suggests measurable spectral movement.`));
    }
  }

  if (spectralFlatness > 0) {
    const noisinessScore = scale(spectralFlatness, 0.16, 0.52);
    if (noisinessScore >= 0.45) {
      const confidence = clamp01(0.49 + noisinessScore * 0.27);
      labels.push(makeAudioTrait("noisiness", "noisy", confidence, `features.spectralFlatness=${formatMetric(spectralFlatness)} indicates a noisy or broad-spectrum texture.`));
    }
  }

  if (envelopeSustainRatio > 0 || envelopeDecayRatio > 0 || attackSeconds > 0) {
    const sustainedScore = Math.max(scale(envelopeSustainRatio, 0.45, 0.85), scale(attackSeconds, 0.03, 0.12));
    if (sustainedScore >= 0.45) {
      const confidence = clamp01(0.5 + sustainedScore * 0.25);
      labels.push(makeAudioTrait("articulation", "sustained", confidence, `render-envelope data showed sustained energy (sustainRatio=${formatMetric(envelopeSustainRatio)}, attackSeconds=${formatMetric(attackSeconds)}).`));
    }

    const pluckedScore = Math.max(scaleInverse(envelopeSustainRatio, 0.1, 0.3), scaleInverse(envelopeDecayRatio, 0.08, 0.24), scaleInverse(attackSeconds, 0.004, 0.03));
    if (pluckedScore >= 0.45) {
      const confidence = clamp01(0.51 + pluckedScore * 0.24);
      labels.push(makeAudioTrait("articulation", "plucked", confidence, `render-envelope data showed a fast-decay profile (sustainRatio=${formatMetric(envelopeSustainRatio)}, decayRatio=${formatMetric(envelopeDecayRatio)}, attackSeconds=${formatMetric(attackSeconds)}).`));
    }
  }

  return labels;
}

function deriveParameterTraitLabels(parameters: readonly ParameterSnapshot[] | undefined): TraitLabel[] {
  if (!parameters || parameters.length === 0) return [];
  const labels: TraitLabel[] = [];

  for (const parameter of parameters) {
    const normalized = getParameterSignal(parameter);
    if (normalized === undefined) continue;
    const parameterKey = parameter.id || parameter.name || "parameter";
    const labelPrefix = `parameter ${JSON.stringify(parameter.name ?? parameter.id)}`;

    if (hasAnyToken(parameter, ["cutoff", "bright", "brightness", "tone", "treble", "air", "high"]) && normalized >= 0.55) {
      const confidence = clamp01(0.46 + normalized * 0.32);
      labels.push(makeParameterTrait("brightness", "bright", confidence, parameterKey, `${labelPrefix} was set relatively high (${formatMetric(normalized)} normalized), which suggests added brightness.`));
    }

    if (hasAnyToken(parameter, ["sub", "bass", "body", "weight", "low"]) && normalized >= 0.55) {
      const confidence = clamp01(0.47 + normalized * 0.3);
      labels.push(makeParameterTrait("bass_weight", "heavy", confidence, parameterKey, `${labelPrefix} was set relatively high (${formatMetric(normalized)} normalized), which suggests more low-end weight.`));
    }

    if (hasAnyToken(parameter, ["drive", "dist", "distortion", "satur", "crush", "resonance", "res"]) && normalized >= 0.45) {
      const confidence = clamp01(0.45 + normalized * 0.31);
      labels.push(makeParameterTrait("intensity", "aggressive", confidence, parameterKey, `${labelPrefix} exceeded the aggression threshold at ${formatMetric(normalized)} normalized.`));
    }

    if (hasAnyToken(parameter, ["lfo", "rate", "depth", "speed", "mod"]) && normalized >= 0.5) {
      const confidence = clamp01(0.44 + normalized * 0.3);
      labels.push(makeParameterTrait("movement", "moving", confidence, parameterKey, `${labelPrefix} exceeded the movement threshold at ${formatMetric(normalized)} normalized.`));
    }

    if (hasAnyToken(parameter, ["noise", "chaos", "random"]) && normalized >= 0.45) {
      const confidence = clamp01(0.43 + normalized * 0.3);
      labels.push(makeParameterTrait("noisiness", "noisy", confidence, parameterKey, `${labelPrefix} was high enough to suggest added noise content.`));
    }

    if (hasAnyToken(parameter, ["attack"]) && normalized >= 0.6) {
      const confidence = clamp01(0.44 + normalized * 0.26);
      labels.push(makeParameterTrait("articulation", "sustained", confidence, parameterKey, `${labelPrefix} was set long enough to imply sustained onset behavior.`));
    }

    if (hasAnyToken(parameter, ["release", "hold"]) && normalized >= 0.6) {
      const confidence = clamp01(0.46 + normalized * 0.26);
      labels.push(makeParameterTrait("articulation", "sustained", confidence, parameterKey, `${labelPrefix} was set long enough to imply sustained tail behavior.`));
    }

    if (hasAnyToken(parameter, ["sustain"]) && normalized >= 0.6) {
      const confidence = clamp01(0.47 + normalized * 0.25);
      labels.push(makeParameterTrait("articulation", "sustained", confidence, parameterKey, `${labelPrefix} remained above the sustain threshold.`));
    }

    if (hasAnyToken(parameter, ["pluck"]) && normalized >= 0.4) {
      const confidence = clamp01(0.47 + normalized * 0.24);
      labels.push(makeParameterTrait("articulation", "plucked", confidence, parameterKey, `${labelPrefix} explicitly signaled plucked behavior.`));
    }

    if (hasAnyToken(parameter, ["attack"]) && normalized <= 0.22) {
      const confidence = clamp01(0.46 + (1 - normalized) * 0.22);
      labels.push(makeParameterTrait("articulation", "plucked", confidence, parameterKey, `${labelPrefix} stayed short enough to imply a plucked onset.`));
    }

    if (hasAnyToken(parameter, ["decay"]) && normalized <= 0.25) {
      const confidence = clamp01(0.47 + (1 - normalized) * 0.22);
      labels.push(makeParameterTrait("articulation", "plucked", confidence, parameterKey, `${labelPrefix} stayed short enough to imply a quick-decay pluck.`));
    }

    if (hasAnyToken(parameter, ["sustain"]) && normalized <= 0.25) {
      const confidence = clamp01(0.46 + (1 - normalized) * 0.21);
      labels.push(makeParameterTrait("articulation", "plucked", confidence, parameterKey, `${labelPrefix} stayed below the sustain threshold, which implies a plucked envelope.`));
    }
  }

  return labels;
}

function collectHintSources(record: PresetRecord): TextHintSource[] {
  const sources: TextHintSource[] = [];

  pushHintSource(sources, record.file.relativePath, "derived_from_filename", "file.relativePath");
  pushHintSource(sources, record.file.fileName, "derived_from_filename", "file.fileName");
  pushHintSource(sources, record.metadataTraits?.category, "derived_from_filename", "metadataTraits.category");
  pushHintSource(sources, record.metadataTraits?.style, "derived_from_filename", "metadataTraits.style");
  pushHintSource(sources, record.metadataTraits?.bank, "derived_from_filename", "metadataTraits.bank");
  for (const tag of record.metadataTraits?.tags ?? []) pushHintSource(sources, tag, "derived_from_filename", "metadataTraits.tags");
  pushHintSource(sources, record.source.manual?.sourceName, "manual", "source.manual.sourceName");
  pushHintSource(sources, record.source.manual?.notes, "manual", "source.manual.notes");
  pushHintSource(sources, record.source.ableton?.trackName, "manual", "source.ableton.trackName");
  pushHintSource(sources, record.source.ableton?.presetName, "manual", "source.ableton.presetName");

  return sources;
}

function pushHintSource(sources: TextHintSource[], value: string | undefined, kind: ProvenanceKind, path: string): void {
  if (!value) return;
  const tokens = tokenize(value);
  if (tokens.size === 0) return;
  sources.push({ text: value, tokens, kind, path });
}

function isTextOnlyFallback(record: PresetRecord): boolean {
  return !record.audioFeatures && (!record.parameters || record.parameters.length === 0);
}

function lowConfidenceForTextHint(kind: ProvenanceKind, matchCount: number): number {
  const base = kind === "manual" ? 0.24 : 0.2;
  return roundConfidence(clamp01(base + Math.min(matchCount - 1, 2) * 0.04));
}

function makeAudioTrait(trait: string, value: string, confidence: number, explanation: string): TraitLabel {
  return {
    trait,
    value,
    confidence,
    provenance: [
      {
        kind: "derived_from_audio",
        path: "audioFeatures",
        confidence,
        detail: `Label derivation v1 inferred ${trait}=${value} from audio. ${explanation}`,
      },
    ],
  };
}

function makeParameterTrait(trait: string, value: string, confidence: number, parameterKey: string, explanation: string): TraitLabel {
  return {
    trait,
    value,
    confidence,
    provenance: [
      {
        kind: "derived_from_parameters",
        path: `parameters.${parameterKey}`,
        confidence,
        detail: `Label derivation v1 inferred ${trait}=${value} from exposed parameters. ${explanation}`,
      },
    ],
  };
}

function makeAudioRole(role: string, confidence: number, explanation: string): RoleLabel {
  return {
    role,
    confidence,
    provenance: [
      {
        kind: "derived_from_audio",
        path: "audioFeatures",
        confidence,
        detail: `Label derivation v1 inferred role=${role} from audio heuristics. ${explanation}`,
      },
    ],
  };
}

function addTraitLabel(map: Map<string, LabelAccumulator<TraitLabel>>, label: TraitLabel): void {
  const key = `${label.trait}:${label.value ?? ""}`;
  const current = map.get(key);
  const strength = label.confidence ?? averageConfidence(label.provenance);
  if (current) {
    current.provenances.push(...label.provenance);
    current.strengths.push(strength);
    return;
  }
  map.set(key, { label, provenances: [...label.provenance], strengths: [strength] });
}

function addRoleLabel(map: Map<string, LabelAccumulator<RoleLabel>>, label: RoleLabel): void {
  const current = map.get(label.role);
  const strength = label.confidence ?? averageConfidence(label.provenance);
  if (current) {
    current.provenances.push(...label.provenance);
    current.strengths.push(strength);
    return;
  }
  map.set(label.role, { label, provenances: [...label.provenance], strengths: [strength] });
}

function dedupeProvenance(provenances: readonly Provenance[]): Provenance[] {
  const seen = new Set<string>();
  const result: Provenance[] = [];
  for (const provenance of provenances) {
    const key = JSON.stringify([provenance.kind, provenance.path ?? "", provenance.detail ?? "", provenance.confidence ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(provenance);
  }
  return result;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0),
  );
}

function hasAnyToken(parameter: ParameterSnapshot, aliases: readonly string[]): boolean {
  const tokens = tokenize([parameter.id, parameter.name].filter(Boolean).join(" "));
  return aliases.some((alias) => tokens.has(alias));
}

function getParameterSignal(parameter: ParameterSnapshot): number | undefined {
  if (typeof parameter.normalizedValue === "number" && Number.isFinite(parameter.normalizedValue)) return clamp01(parameter.normalizedValue);
  if (typeof parameter.value === "number" && Number.isFinite(parameter.value) && parameter.value >= 0 && parameter.value <= 1) {
    return clamp01(parameter.value);
  }
  return undefined;
}

function getFeature(audioFeatures: AudioFeatureVector, key: string): number {
  const value = audioFeatures.features?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasTrait(labels: readonly TraitLabel[], trait: string, value: string): boolean {
  return labels.some((label) => label.trait === trait && label.value === value);
}

function scale(value: number | undefined, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || max <= min) return 0;
  return clamp01((value - min) / (max - min));
}

function scaleInverse(value: number | undefined, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || max <= min) return 0;
  return clamp01((max - value) / (max - min));
}

function combineConfidence(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let remainder = 1;
  for (const value of values) remainder *= 1 - clamp01(value);
  return roundConfidence(1 - remainder);
}

function averageConfidence(values: readonly Provenance[]): number {
  if (values.length === 0) return 0;
  const confidences = values
    .map((value) => value.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (confidences.length === 0) return 0;
  return roundConfidence(confidences.reduce((sum, value) => sum + value, 0) / confidences.length);
}

function compareTraitLabels(left: TraitLabel, right: TraitLabel): number {
  return (right.confidence ?? 0) - (left.confidence ?? 0)
    || left.trait.localeCompare(right.trait)
    || (left.value ?? "").localeCompare(right.value ?? "");
}

function compareRoleLabels(left: RoleLabel, right: RoleLabel): number {
  return (right.confidence ?? 0) - (left.confidence ?? 0)
    || left.role.localeCompare(right.role);
}

function formatMetric(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(3);
}

function roundConfidence(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

void PRESET_CORPUS_SCHEMA_VERSION;
