import fs from "node:fs";
import { measureAPO } from "./measure.ts";
import type { MeasureOptions, MetricBands, ScalarAPO } from "./measure.ts";
import type { AudioFeatureVector, Provenance } from "./presetCorpus.ts";
import { decodeWav } from "./wav.ts";

export interface Float32AudioInput {
  samples: Float32Array | ArrayLike<number>;
  sampleRate: number;
  channelData?: Float32Array[];
}

export interface WavBufferAudioInput {
  wavBuffer: Buffer | ArrayBuffer | Uint8Array;
}

export interface WavPathAudioInput {
  wavPath: string;
}

export type AudioFeatureInput = Float32AudioInput | WavBufferAudioInput | WavPathAudioInput;

export interface AudioRenderProtocol {
  midiNotes: string[];
  velocity: number;
  noteDurationSeconds: number;
  renderLengthSeconds: number;
  trimThreshold: number;
  fixtureRepeatCount: number;
  rigRepeatCount: number;
}

export interface ExtractAudioFeaturesOptions extends MeasureOptions {
  mode?: "fixture" | "rig";
  protocol?: Partial<AudioRenderProtocol>;
}

interface ResolvedAudioInput {
  samples: Float32Array;
  sampleRate: number;
  channelData: Float32Array[];
}

interface AnalyzedAudio {
  vector: AudioFeatureVector;
  confidence: number;
  silent: boolean;
  channels: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  analysisDurationSeconds: number;
  peakBeforeNormalization: number;
  normalizationGain: number;
}

export const DEFAULT_AUDIO_RENDER_PROTOCOL: AudioRenderProtocol = {
  midiNotes: ["C2", "C3", "C4"],
  velocity: 100,
  noteDurationSeconds: 2.0,
  renderLengthSeconds: 2.5,
  trimThreshold: 1e-4,
  fixtureRepeatCount: 1,
  rigRepeatCount: 3,
};

export function extractAudioFeatures(
  input: AudioFeatureInput | readonly AudioFeatureInput[],
  options: ExtractAudioFeaturesOptions = {},
): AudioFeatureVector {
  const protocol = { ...DEFAULT_AUDIO_RENDER_PROTOCOL, ...options.protocol };
  const inputs = Array.isArray(input) ? [...input] : [input];
  if (inputs.length === 0) {
    throw new Error("extractAudioFeatures: expected at least one input");
  }

  const analyses = inputs.map((item) => analyzeOne(item, options, protocol));
  const sampleRate = analyses[0]!.vector.sampleRate;
  if (sampleRate === undefined) {
    throw new Error("extractAudioFeatures: missing sample rate");
  }
  for (const analysis of analyses) {
    if (analysis.vector.sampleRate !== sampleRate) {
      throw new Error("extractAudioFeatures: repeat inputs must share a sample rate");
    }
  }

  const vector = averageVectors(analyses.map((analysis) => analysis.vector));
  const repeatCount = analyses.length;
  const mode = options.mode ?? "fixture";
  const silentRepeats = analyses.reduce((sum, analysis) => sum + (analysis.silent ? 1 : 0), 0);
  const averageConfidence = average(analyses.map((analysis) => analysis.confidence));
  const averageChannels = average(analyses.map((analysis) => analysis.channels));
  const averageTrimStart = average(analyses.map((analysis) => analysis.trimStartSeconds));
  const averageTrimEnd = average(analyses.map((analysis) => analysis.trimEndSeconds));
  const averageAnalysisDuration = average(analyses.map((analysis) => analysis.analysisDurationSeconds));
  const averagePeak = average(analyses.map((analysis) => analysis.peakBeforeNormalization));
  const averageGain = average(analyses.map((analysis) => analysis.normalizationGain));
  const features = {
    ...(vector.features ?? {}),
    analysisTrimThreshold: protocol.trimThreshold,
    analysisRepeatCount: repeatCount,
    analysisConfidence: averageConfidence,
    analysisSilent: silentRepeats === repeatCount ? 1 : 0,
    analysisSilentRepeatCount: silentRepeats,
    analysisTrimStartSeconds: averageTrimStart,
    analysisTrimEndSeconds: averageTrimEnd,
    analysisDurationSeconds: averageAnalysisDuration,
    analysisPeakBeforeNormalization: averagePeak,
    analysisNormalizationGain: averageGain,
    analysisMonoMixdownApplied: averageChannels > 1 ? 1 : 0,
    analysisSourceChannels: averageChannels,
    protocolVelocity: protocol.velocity,
    protocolNoteDurationSeconds: protocol.noteDurationSeconds,
    protocolRenderLengthSeconds: protocol.renderLengthSeconds,
    protocolFixtureRepeatCount: protocol.fixtureRepeatCount,
    protocolRigRepeatCount: protocol.rigRepeatCount,
    protocolNoteCount: protocol.midiNotes.length,
    protocolHighBandHz: (options.bands ?? DEFAULT_BANDS).highHz,
    protocolBassBandHz: (options.bands ?? DEFAULT_BANDS).bassHz,
  };

  return {
    ...vector,
    sampleRate,
    features,
    provenance: [
      buildProvenance({
        protocol,
        mode,
        repeatCount,
        silentRepeats,
        confidence: averageConfidence,
        monoMixdownApplied: averageChannels > 1,
      }),
    ],
  };
}

const DEFAULT_BANDS: MetricBands = { highHz: 600, bassHz: 150 };

function analyzeOne(
  input: AudioFeatureInput,
  options: ExtractAudioFeaturesOptions,
  protocol: AudioRenderProtocol,
): AnalyzedAudio {
  const resolved = resolveInput(input);
  const trimmed = trimSilence(resolved.samples, resolved.channelData, protocol.trimThreshold);
  const peak = peakAbs(trimmed.samples);
  const gain = peak > 0 ? 1 / peak : 0;
  const normalizedSamples = gain > 0 ? scaleBuffer(trimmed.samples, gain) : new Float32Array(trimmed.samples.length);
  const normalizedChannels = gain > 0
    ? trimmed.channelData.map((channel) => scaleBuffer(channel, gain))
    : trimmed.channelData.map((channel) => new Float32Array(channel.length));
  const measureOptions: MeasureOptions = {};
  if (options.frameSize !== undefined) measureOptions.frameSize = options.frameSize;
  if (options.bands !== undefined) measureOptions.bands = options.bands;
  measureOptions.channelData = trimmed.channelData;
  const rawApo = measureAPO(trimmed.samples, resolved.sampleRate, measureOptions);
  measureOptions.channelData = normalizedChannels;
  const normalizedApo = measureAPO(normalizedSamples, resolved.sampleRate, measureOptions);
  const confidence = trimmed.silent ? 0.1 : peak <= protocol.trimThreshold * 4 ? 0.35 : 1;

  return {
    vector: {
      sampleRate: resolved.sampleRate,
      durationSeconds: resolved.samples.length / resolved.sampleRate,
      centroid: finiteOrZero(normalizedApo.centroid),
      highRatio: clampUnit(normalizedApo.highRatio),
      bassRatio: clampUnit(normalizedApo.bassRatio),
      rms: finiteOrZero(rawApo.rms),
      features: buildFeatureMap(rawApo, normalizedApo),
    },
    confidence,
    silent: trimmed.silent,
    channels: resolved.channelData.length,
    trimStartSeconds: trimmed.start / resolved.sampleRate,
    trimEndSeconds: (resolved.samples.length - trimmed.endExclusive) / resolved.sampleRate,
    analysisDurationSeconds: trimmed.samples.length / resolved.sampleRate,
    peakBeforeNormalization: peak,
    normalizationGain: gain,
  };
}

function resolveInput(input: AudioFeatureInput): ResolvedAudioInput {
  if ("wavPath" in input) {
    const decoded = decodeWav(fs.readFileSync(input.wavPath));
    return {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      channelData: decoded.channelData,
    };
  }

  if ("wavBuffer" in input) {
    const decoded = decodeWav(input.wavBuffer);
    return {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      channelData: decoded.channelData,
    };
  }

  const mono = toFloat32Array(input.samples);
  return {
    samples: mono,
    sampleRate: input.sampleRate,
    channelData: input.channelData ? input.channelData.map((channel) => toFloat32Array(channel)) : [mono],
  };
}

function trimSilence(
  samples: Float32Array,
  channelData: Float32Array[],
  threshold: number,
): {
  samples: Float32Array;
  channelData: Float32Array[];
  start: number;
  endExclusive: number;
  silent: boolean;
} {
  let start = 0;
  let endExclusive = samples.length;
  while (start < samples.length && Math.abs(samples[start] ?? 0) <= threshold) start++;
  while (endExclusive > start && Math.abs(samples[endExclusive - 1] ?? 0) <= threshold) endExclusive--;

  if (start >= endExclusive) {
    return {
      samples: new Float32Array(1),
      channelData: channelData.map(() => new Float32Array(1)),
      start: 0,
      endExclusive: 0,
      silent: true,
    };
  }

  return {
    samples: samples.slice(start, endExclusive),
    channelData: channelData.map((channel) => channel.slice(start, endExclusive)),
    start,
    endExclusive,
    silent: false,
  };
}

function buildFeatureMap(rawApo: ScalarAPO, normalizedApo: ScalarAPO): Record<string, number> {
  return {
    crest: finiteOrZero(rawApo.crest),
    loudnessLufs: finiteOrZero(rawApo.loudnessLufs),
    flux: finiteOrZero(normalizedApo.flux),
    stereoWidth: finiteOrZero(normalizedApo.stereoWidth),
    correlation: finiteOrZero(normalizedApo.correlation),
    corrBelow120: finiteOrZero(normalizedApo.corrBelow120),
  };
}

function buildProvenance({
  protocol,
  mode,
  repeatCount,
  silentRepeats,
  confidence,
  monoMixdownApplied,
}: {
  protocol: AudioRenderProtocol;
  mode: "fixture" | "rig";
  repeatCount: number;
  silentRepeats: number;
  confidence: number;
  monoMixdownApplied: boolean;
}): Provenance {
  return {
    kind: "derived_from_audio",
    path: "audioFeatures",
    confidence,
    detail: [
      `protocol=v1`,
      `mode=${mode}`,
      `midiNotes=${protocol.midiNotes.join(",")}`,
      `velocity=${protocol.velocity}`,
      `noteDurationSeconds=${protocol.noteDurationSeconds.toFixed(1)}`,
      `renderLengthSeconds=${protocol.renderLengthSeconds.toFixed(1)}`,
      `trimThreshold=${protocol.trimThreshold}`,
      `fixtureRepeatCount=${protocol.fixtureRepeatCount}`,
      `rigRepeatCount=${protocol.rigRepeatCount}`,
      `averagedRepeats=${repeatCount}`,
      `monoMixdownApplied=${monoMixdownApplied ? "yes" : "no"}`,
      `silentRepeats=${silentRepeats}`,
      `peakNormalization=analysis_only`,
    ].join("; "),
  };
}

function averageVectors(vectors: readonly AudioFeatureVector[]): AudioFeatureVector {
  const out: AudioFeatureVector = {};
  const sampleRate = vectors[0]?.sampleRate;
  const durationSeconds = averageOptional(vectors.map((vector) => vector.durationSeconds));
  const centroid = averageOptional(vectors.map((vector) => vector.centroid));
  const highRatio = averageOptional(vectors.map((vector) => vector.highRatio));
  const bassRatio = averageOptional(vectors.map((vector) => vector.bassRatio));
  const rms = averageOptional(vectors.map((vector) => vector.rms));
  if (sampleRate !== undefined) out.sampleRate = sampleRate;
  if (durationSeconds !== undefined) out.durationSeconds = durationSeconds;
  if (centroid !== undefined) out.centroid = centroid;
  if (highRatio !== undefined) out.highRatio = highRatio;
  if (bassRatio !== undefined) out.bassRatio = bassRatio;
  if (rms !== undefined) out.rms = rms;
  out.features = averageNumberMaps(vectors.map((vector) => vector.features ?? {}));
  return out;
}

function averageNumberMaps(maps: readonly Record<string, number>[]): Record<string, number> {
  const keys = new Set<string>();
  for (const map of maps) {
    for (const key of Object.keys(map)) keys.add(key);
  }
  const out: Record<string, number> = {};
  for (const key of keys) {
    const values = maps.flatMap((map) => key in map ? [map[key]!] : []);
    out[key] = average(values);
  }
  return out;
}

function averageOptional(values: readonly (number | undefined)[]): number | undefined {
  const present = values.flatMap((value) => value === undefined ? [] : [value]);
  return present.length > 0 ? average(present) : undefined;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function peakAbs(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

function scaleBuffer(samples: Float32Array, gain: number): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) * gain;
  return out;
}

function toFloat32Array(samples: Float32Array | ArrayLike<number>): Float32Array {
  if (samples instanceof Float32Array) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] ?? 0;
  return out;
}
