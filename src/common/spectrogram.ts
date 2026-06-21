// Short-time Fourier transform + frame-domain features. Pure, dependency-free; reuses the
// same radix-2 `fft` as the single-frame centroid/APO path. This is the shared base for:
//   - spectralFlux  (movement/animation metric — frame-to-frame magnitude change)
//   - coarseGrid    (a tiny time×frequency numeric "spectrogram" for the full APO)
//   - a future mel-spectrogram PNG (not built; see specs/AUDIO_AWARENESS_SPEC.md §5)
//
// Hot loops index typed arrays bounded by `.length`, so reads are in range; the `!`
// non-null assertions avoid a per-sample `?? 0` that `noUncheckedIndexedAccess` would force.

import { fft } from "./centroid.ts";

export interface STFT {
  /** One magnitude spectrum per frame; each Float64Array has frameSize/2 bins. */
  frames: Float64Array[];
  /** Center frequency (Hz) of each bin, length frameSize/2. */
  freqs: Float64Array;
}

export interface STFTOptions {
  frameSize?: number;
  hop?: number;
}

// Magnitude STFT with a Hann window. Always returns at least one frame (short signals are
// zero-padded into a single frame), so downstream features never divide by zero frames.
export function stft(
  signal: ArrayLike<number>,
  sampleRate: number,
  { frameSize = 2048, hop = 1024 }: STFTOptions = {}
): STFT {
  const n = frameSize;
  const half = n >> 1;
  const len = signal.length;
  const frameCount = len <= n ? 1 : Math.floor((len - n) / hop) + 1;

  // Precompute the Hann window once.
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

  const frames: Float64Array[] = [];
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    im.fill(0);
    for (let i = 0; i < n; i++) {
      const s = start + i < len ? signal[start + i]! : 0; // zero-pad the tail
      re[i] = s * win[i]!;
    }
    fft(re, im);
    const mag = new Float64Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    frames.push(mag);
  }

  const freqs = new Float64Array(half);
  for (let k = 0; k < half; k++) freqs[k] = (k * sampleRate) / n;

  return { frames, freqs };
}

// Spectral flux: mean over frames of the summed positive bin-to-bin magnitude increase.
// Rises when the spectrum changes over time (modulation, beating, tremolo); ~0 for a steady
// tone. Unnormalized (scale-comparable across similar-amplitude renders), which is all the
// `movement` recipe needs — it compares before/after on the same source.
export function spectralFlux(frames: Float64Array[]): number {
  if (frames.length < 2) return 0;
  let total = 0;
  for (let t = 1; t < frames.length; t++) {
    const cur = frames[t]!;
    const prev = frames[t - 1]!;
    let acc = 0;
    for (let k = 0; k < cur.length; k++) {
      const d = cur[k]! - prev[k]!;
      if (d > 0) acc += d;
    }
    total += acc;
  }
  return total / (frames.length - 1);
}

export interface CoarseGridOptions {
  nTime?: number;
  nBands?: number;
}

// A small time×frequency grid (default 8×8), peak-normalized to 0..1 — a compact numeric
// "spectrogram" the LLM can read directly (movement over time, where energy sits) without an
// image. Bands are log-spaced (perceptually closer to how frequency is heard). Time slices
// average the available frames; if there are fewer frames than nTime, slices repeat-sample.
export function coarseGrid(
  frames: Float64Array[],
  freqs: Float64Array,
  { nTime = 8, nBands = 8 }: CoarseGridOptions = {}
): number[][] {
  const half = freqs.length;
  if (half === 0 || frames.length === 0) {
    return Array.from({ length: nTime }, () => new Array(nBands).fill(0));
  }

  // Log-spaced band edges from the first non-DC bin up to Nyquist.
  const fMin = Math.max(freqs[1] ?? 1, 1);
  const fMax = freqs[half - 1] || fMin * 2;
  const logMin = Math.log(fMin);
  const logMax = Math.log(fMax);
  const bandOf = (freq: number): number => {
    if (freq <= fMin) return 0;
    if (freq >= fMax) return nBands - 1;
    const t = (Math.log(freq) - logMin) / (logMax - logMin);
    return Math.min(nBands - 1, Math.max(0, Math.floor(t * nBands)));
  };

  const grid: number[][] = Array.from({ length: nTime }, () => new Array(nBands).fill(0));

  for (let ti = 0; ti < nTime; ti++) {
    // Map this time-slice to a span of frames.
    const fStart = Math.floor((ti * frames.length) / nTime);
    const fEnd = Math.max(fStart + 1, Math.floor(((ti + 1) * frames.length) / nTime));
    const row = grid[ti]!;
    let frameN = 0;
    for (let f = fStart; f < fEnd && f < frames.length; f++) {
      const mag = frames[f]!;
      for (let k = 1; k < half; k++) row[bandOf(freqs[k]!)]! += mag[k]! * mag[k]!; // power
      frameN++;
    }
    if (frameN > 0) for (let bIdx = 0; bIdx < nBands; bIdx++) row[bIdx]! /= frameN;
  }

  // Peak-normalize the whole grid to 0..1.
  let peak = 0;
  for (const row of grid) for (const v of row) if (v > peak) peak = v;
  if (peak > 0) for (const row of grid) for (let bIdx = 0; bIdx < row.length; bIdx++) row[bIdx]! /= peak;

  return grid;
}
