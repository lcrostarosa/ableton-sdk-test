// The Audio Perception Object (APO) — the multi-feature "ear" the recipe layer targets.
//
// SCALAR vs FULL (see specs plan D5): the convergence loop and the apply-intent surface work
// in `ScalarAPO` (targetable numbers only). The full `APO` adds a `spectrogram` grid and is
// built ONLY at terminal/perception points (`render_audio`) — never inside the loop, so a
// `number[][]` is never a `Metric` and no throwaway STFT grid is computed per iteration.
//
//   centroid     : brightness (Hz)               — "make it brighter"
//   highRatio    : energy fraction above ~600 Hz  — harmonic "bite"; drive/aggression grow it
//   bassRatio    : energy fraction below ~150 Hz  — low-end weight; "more bass" grows it
//   rms          : loudness (0..1)                — guard/invariant
//   crest        : peak/RMS                       — transient/punch vs. squashed
//   loudnessLufs : K-weighted loudness (LUFS)     — perceptual level (BS.1770, ungated)
//   flux         : spectral flux                  — movement/animation over time
//   stereoWidth  : side/(mid+side) energy 0..1    — "wider"; 0 on mono
//   correlation  : inter-channel Pearson -1..1    — mono-compat / phase; 1 on mono
//   corrBelow120 : correlation under ~120 Hz      — clean-sub groundwork; 1 on mono
//
// The legacy four (centroid/highRatio/bassRatio/rms) keep their EXACT single-frame math so
// recipe calibration and the existing tests stay bit-stable (plan D3). New multi-frame
// features (flux, spectrogram) use the separate STFT path in spectrogram.ts. Pure, no deps.

import { fft } from "./centroid.ts";
import { stft, spectralFlux, coarseGrid } from "./spectrogram.ts";
import type { CoarseGridOptions } from "./spectrogram.ts";

// Targetable scalar features. `Metric` is "a ScalarAPO field a recipe can converge on".
export interface ScalarAPO {
  centroid: number;
  highRatio: number;
  bassRatio: number;
  rms: number;
  crest: number;
  loudnessLufs: number;
  flux: number;
  stereoWidth: number;
  correlation: number;
  corrBelow120: number;
}
export type Metric = keyof ScalarAPO;

// The full perception object adds the non-targetable coarse spectrogram grid.
export interface APO extends ScalarAPO {
  /** Small time×band numeric "spectrogram" (peak-normalized 0..1); render_audio only. */
  spectrogram: number[][];
}

// Stereo-only metrics: meaningless on a mono render (they sit at their mono defaults). The
// engine uses this set to guard recipes that target them (mono-render early exit).
export const STEREO_METRICS: ReadonlySet<Metric> = new Set<Metric>([
  "stereoWidth",
  "correlation",
  "corrBelow120",
]);

// Where the high/bass band-energy ratios split the spectrum, in Hz.
export interface MetricBands {
  highHz: number;
  bassHz: number;
}

export const DEFAULT_BANDS: MetricBands = { highHz: 600, bassHz: 150 };

export interface MeasureOptions {
  frameSize?: number;
  bands?: MetricBands;
  /** Per-channel signals (from decodeWav). Absent/mono → stereo fields take mono defaults. */
  channelData?: Float32Array[] | undefined;
}

// Mono defaults: a mono signal is perfectly correlated, zero width.
const MONO_STEREO = { stereoWidth: 0, correlation: 1, corrBelow120: 1 };

/**
 * Scalar APO — every targetable feature, no spectrogram grid. This is what the convergence
 * loop and adapters return.
 */
export function measureScalar(
  signal: ArrayLike<number>,
  sampleRate: number,
  { frameSize = 2048, bands = DEFAULT_BANDS, channelData }: MeasureOptions = {}
): ScalarAPO {
  // --- single-frame spectrum (legacy fields — math unchanged for bit-stability) ---
  const n = frameSize;
  const start = Math.max(0, (signal.length - n) >> 1);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = signal[start + i] || 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    re[i] = s * w;
  }
  fft(re, im);

  let cNum = 0, cDen = 0;
  let pTotal = 0, pHigh = 0, pBass = 0;
  for (let k = 1; k < n / 2; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    const freq = (k * sampleRate) / n;
    cNum += freq * mag;
    cDen += mag;
    const pow = mag * mag;
    pTotal += pow;
    if (freq >= bands.highHz) pHigh += pow;
    if (freq <= bands.bassHz) pBass += pow;
  }

  // RMS + peak over the whole signal (time domain).
  let sq = 0, peak = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i]!;
    sq += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const rms = signal.length ? Math.sqrt(sq / signal.length) : 0;

  // --- new scalar features ---
  const crest = rms > 0 ? peak / rms : 0;
  const loudnessLufs = loudnessLufsOf(signal, sampleRate);
  const flux = spectralFlux(stft(signal, sampleRate, { frameSize }).frames);
  const stereo =
    channelData && channelData.length >= 2
      ? stereoMetrics(channelData, sampleRate)
      : MONO_STEREO;

  return {
    centroid: cDen > 0 ? cNum / cDen : 0,
    highRatio: pTotal > 0 ? pHigh / pTotal : 0,
    bassRatio: pTotal > 0 ? pBass / pTotal : 0,
    rms,
    crest,
    loudnessLufs,
    flux,
    stereoWidth: stereo.stereoWidth,
    correlation: stereo.correlation,
    corrBelow120: stereo.corrBelow120,
  };
}

export const measureAPO = measureScalar;

/**
 * Full APO — scalar features plus the coarse spectrogram grid. Use at perception endpoints
 * (render_audio), not inside the convergence loop.
 */
export function measureFull(
  signal: ArrayLike<number>,
  sampleRate: number,
  opts: MeasureOptions & CoarseGridOptions = {}
): APO {
  const scalar = measureScalar(signal, sampleRate, opts);
  const { frames, freqs } = stft(signal, sampleRate, { frameSize: opts.frameSize ?? 2048 });
  // Build grid options without explicit `undefined` (exactOptionalPropertyTypes is on).
  const gridOpts: CoarseGridOptions = {};
  if (opts.nTime !== undefined) gridOpts.nTime = opts.nTime;
  if (opts.nBands !== undefined) gridOpts.nBands = opts.nBands;
  const spectrogram = coarseGrid(frames, freqs, gridOpts);
  return { ...scalar, spectrogram };
}

// ---- crest is inline above; loudness + stereo helpers below ----

// BS.1770 K-weighting (two biquads) + ungated integrated loudness. Coefficients are derived
// from the passed `sampleRate` via RBJ designs of the standard prefilters (NOT hardcoded to
// 48 kHz), so the render's actual rate is honored. Ungated: fine for steady test tones; on
// dynamic material this diverges from gated "integrated" loudness (documented; see plan).
export function loudnessLufsOf(signal: ArrayLike<number>, sampleRate: number): number {
  if (!signal.length) return -Infinity;
  // Stage 1: high-shelf, fc≈1681.97 Hz, +3.999 dB, Q≈0.7071 (pyloudnorm/ITU prefilter).
  const s1 = highShelf(sampleRate, 1681.974450955533, 3.999843853973347, 1 / Math.SQRT2);
  // Stage 2: high-pass (RLB), fc≈38.135 Hz, Q≈0.5003.
  const s2 = highPass(sampleRate, 38.13547087602444, 0.5003270373238773);
  let sq = 0;
  let x1a = 0, x2a = 0, y1a = 0, y2a = 0; // stage 1 state
  let x1b = 0, x2b = 0, y1b = 0, y2b = 0; // stage 2 state
  for (let i = 0; i < signal.length; i++) {
    const x = signal[i]!;
    const ya = s1.b0 * x + s1.b1 * x1a + s1.b2 * x2a - s1.a1 * y1a - s1.a2 * y2a;
    x2a = x1a; x1a = x; y2a = y1a; y1a = ya;
    const yb = s2.b0 * ya + s2.b1 * x1b + s2.b2 * x2b - s2.a1 * y1b - s2.a2 * y2b;
    x2b = x1b; x1b = ya; y2b = y1b; y1b = yb;
    sq += yb * yb;
  }
  const meanSquare = sq / signal.length;
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }

function highShelf(sr: number, fc: number, gainDb: number, q: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cw + twoSqrtAalpha;
  return {
    b0: (A * ((A + 1) + (A - 1) * cw + twoSqrtAalpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cw)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cw - twoSqrtAalpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cw)) / a0,
    a2: ((A + 1) - (A - 1) * cw - twoSqrtAalpha) / a0,
  };
}

function highPass(sr: number, fc: number, q: number): Biquad {
  const w0 = (2 * Math.PI * fc) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export interface StereoMetrics {
  stereoWidth: number;
  correlation: number;
  corrBelow120: number;
}

// Inter-channel measures from L/R. correlation = Pearson(L,R); stereoWidth = side/(mid+side)
// energy ∈ [0,1]; corrBelow120 = correlation after a one-pole low-pass (the clean-sub probe).
export function stereoMetrics(
  channelData: Float32Array[],
  sampleRate: number,
  subHz = 120
): StereoMetrics {
  const L = channelData[0]!;
  const R = channelData[1]!;
  const n = Math.min(L.length, R.length);
  if (n === 0) return { ...MONO_STEREO };

  // mid/side energy → width
  let midSq = 0, sideSq = 0;
  for (let i = 0; i < n; i++) {
    const mid = (L[i]! + R[i]!) * 0.5;
    const side = (L[i]! - R[i]!) * 0.5;
    midSq += mid * mid;
    sideSq += side * side;
  }
  const midRms = Math.sqrt(midSq / n);
  const sideRms = Math.sqrt(sideSq / n);
  const stereoWidth = midRms + sideRms > 0 ? sideRms / (midRms + sideRms) : 0;

  return {
    stereoWidth,
    correlation: pearson(L, R, n),
    corrBelow120: pearson(onePoleLowpass(L, n, sampleRate, subHz), onePoleLowpass(R, n, sampleRate, subHz), n),
  };
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, n: number): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma, db = b[i]! - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 0 ? cov / denom : 1; // two flat (silent) channels are trivially "correlated"
}

function onePoleLowpass(x: ArrayLike<number>, n: number, sampleRate: number, fc: number): Float32Array {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * fc);
  const a = dt / (rc + dt);
  const out = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) { y = y + a * (x[i]! - y); out[i] = y; }
  return out;
}
