// Spectral centroid — the demo's single "ear".
// Pure, dependency-free. Same function will run inside Node for Max on the real Serum render.
//
// The numeric kernels index typed arrays inside loops bounded by `.length`, so the reads are
// always in range. `noUncheckedIndexedAccess` can't prove that, so those hot reads use the
// non-null assertion (`!`) rather than paying for a runtime `?? 0` on every sample.

// In-place iterative radix-2 FFT (n must be a power of 2).
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!, ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cwr - im[i + k + len / 2]! * cwi;
        const bi = re[i + k + len / 2]! * cwi + im[i + k + len / 2]! * cwr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
}

// Spectral centroid in Hz of one windowed frame taken from the middle of the signal.
export function spectralCentroid(
  signal: ArrayLike<number>,
  sampleRate: number,
  frameSize = 2048
): number {
  const n = frameSize;
  const start = Math.max(0, (signal.length - n) >> 1);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = signal[start + i] || 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    re[i] = s * w;
  }
  fft(re, im);
  let num = 0, den = 0;
  for (let k = 1; k < n / 2; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    const freq = (k * sampleRate) / n;
    num += freq * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}
