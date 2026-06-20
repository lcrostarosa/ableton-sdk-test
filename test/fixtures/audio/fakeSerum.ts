// FakeSerum — a stand-in for "Serum + render" so the loop runs with no Ableton.
// A sawtooth bass note through a cascaded low-pass whose cutoff is the one param we control.
// In the real device this whole class is replaced by: LiveAPI param set + sfrecord~ capture.
//
// The render loop indexes its own buffer inside `for (i < N)` loops, so the reads are always
// in range; `noUncheckedIndexedAccess` can't prove it, hence the `!` on the hot reads.

export interface FakeSerumOptions {
  f0?: number;
  sampleRate?: number;
  durationSec?: number;
}

export class FakeSerum {
  f0: number;
  sampleRate: number;
  durationSec: number;
  cutoff: number;
  drive: number;
  reso: number;
  subLevel: number;
  detune: number;
  lfoRate: number;

  constructor({ f0 = 55, sampleRate = 44100, durationSec = 0.7 }: FakeSerumOptions = {}) {
    this.f0 = f0;                 // ~A1, a bass note
    this.sampleRate = sampleRate;
    this.durationSec = durationSec;
    this.cutoff = 0.5;            // normalized 0..1, like an automatable plugin param
    this.drive = 0;               // pre-filter saturation — adds harmonics ("aggression")
    this.reso = 0;                // filter resonance — emphasises energy near the cutoff
    this.subLevel = 0;            // sub sine an octave below f0 — moves bassRatio
    this.detune = 0;              // unison spread — extra saws beating around f0 ("wider")
    this.lfoRate = 0;             // tremolo rate — amplitude movement ("more movement")
  }

  setCutoff(v: number): void { this.cutoff = v; }
  getCutoff(): number { return this.cutoff; }
  setDrive(v: number): void { this.drive = v; }
  getDrive(): number { return this.drive; }
  setReso(v: number): void { this.reso = v; }
  getReso(): number { return this.reso; }
  setSubLevel(v: number): void { this.subLevel = v; }
  getSubLevel(): number { return this.subLevel; }
  setDetune(v: number): void { this.detune = v; }
  getDetune(): number { return this.detune; }
  setLfoRate(v: number): void { this.lfoRate = v; }
  getLfoRate(): number { return this.lfoRate; }

  // "Play the note and render the audio" — returns a Float32 buffer.
  render(): Float32Array {
    const sr = this.sampleRate;
    const N = Math.floor(sr * this.durationSec);
    const buf = new Float32Array(N);

    // naive sawtooth oscillator; detune > 0 adds two unison saws beating around f0
    // (chorus-like thickening — the "wider" recipe's knob). detune === 0 keeps the exact
    // original single-saw path so existing tests are unchanged.
    if (this.detune === 0) {
      let phase = 0;
      const inc = this.f0 / sr;
      for (let i = 0; i < N; i++) {
        buf[i] = 2 * phase - 1;
        phase += inc;
        if (phase >= 1) phase -= 1;
      }
    } else {
      const spread = 1 + this.detune * 0.06; // up to ~±6% pitch spread at detune=1
      const incs = [this.f0 / sr, (this.f0 * spread) / sr, this.f0 / spread / sr];
      const gains = [1, 0.7, 0.7];
      const phases = [0, 0.33, 0.66];
      const norm = 1 / (gains[0]! + gains[1]! + gains[2]!);
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let v = 0; v < 3; v++) {
          s += gains[v]! * (2 * phases[v]! - 1);
          phases[v] = phases[v]! + incs[v]!;
          if (phases[v]! >= 1) phases[v] = phases[v]! - 1;
        }
        buf[i] = s * norm;
      }
    }

    // normalized cutoff -> Hz, exponential like a real filter knob (200 Hz .. 8 kHz)
    const fc = 200 * Math.pow(8000 / 200, this.cutoff);

    // Default patch (no drive/reso) keeps the exact original filter path so existing
    // tests are unchanged.
    if (this.drive === 0 && this.reso === 0) {
      const dt = 1 / sr;
      const rc = 1 / (2 * Math.PI * fc);
      const a = dt / (rc + dt);
      for (let stage = 0; stage < 4; stage++) {
        let y = 0;
        for (let i = 0; i < N; i++) {
          y = y + a * (buf[i]! - y);
          buf[i] = y;
        }
      }
    } else {
      // Drive: soft saturation before the filter — generates harmonics that show up as
      // higher centroid AND more energy above 2 kHz (what the "aggressive" recipe targets).
      if (this.drive > 0) {
        const g = 1 + this.drive * 8;
        for (let i = 0; i < N; i++) buf[i] = Math.tanh(buf[i]! * g);
      }

      // Resonant low-pass (RBJ biquad), cascaded twice (~24 dB/oct). Q rises with reso,
      // peaking energy near fc.
      const Q = 0.7071 + this.reso * 7;
      const w0 = (2 * Math.PI * fc) / sr;
      const cw = Math.cos(w0), sw = Math.sin(w0);
      const alpha = sw / (2 * Q);
      const a0 = 1 + alpha;
      const b0 = ((1 - cw) / 2) / a0;
      const b1 = (1 - cw) / a0;
      const b2 = ((1 - cw) / 2) / a0;
      const a1 = (-2 * cw) / a0;
      const a2 = (1 - alpha) / a0;

      for (let stage = 0; stage < 2; stage++) {
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < N; i++) {
          const x0 = buf[i]!;
          const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
          buf[i] = y0;
        }
      }
    }

    // Sub oscillator: a cosine at f0, mixed in post-filter (like Serum's sub bypassing the
    // filter) — moves bassRatio without touching the upper spectrum. Cosine, not sine: the
    // saw's fundamental is sine-phased, so a sine sub at f0 would phase-CANCEL it (bassRatio
    // would fall as the sub comes up); quadrature makes the energies add. And f0, not f0/2:
    // 27.5 Hz is under-resolved by the analysis frame (leakage interferes instead of adding).
    if (this.subLevel > 0) {
      const w = (2 * Math.PI * this.f0) / sr;
      for (let i = 0; i < N; i++) buf[i] = buf[i]! + this.subLevel * 0.8 * Math.cos(w * i);
    }

    // Tremolo LFO: amplitude movement — the "more movement" recipe's knob.
    if (this.lfoRate > 0) {
      const rateHz = 0.5 + this.lfoRate * 7.5;
      const w = (2 * Math.PI * rateHz) / sr;
      const depth = 0.3;
      for (let i = 0; i < N; i++) {
        buf[i] = buf[i]! * (1 - depth * (0.5 + 0.5 * Math.sin(w * i)));
      }
    }

    return buf;
  }
}
