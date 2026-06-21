// Round-trip the WAV codec and confirm the decoded signal measures the brightness we put in.
// Pure Node, no rig.  node test/wav.test.ts
import assert from "node:assert";
import { encodeWav, encodeWavStereo, decodeWav } from "../src/common/wav.ts";
import { spectralCentroid } from "../src/common/centroid.ts";

let pass = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
    pass++;
  } catch (e) {
    console.log(
      "  ✗ " + name + " - " + (e instanceof Error ? e.message : String(e)),
    );
    process.exitCode = 1;
  }
}

function sine(freq: number, sr: number, n: number, amp = 0.8): Float32Array {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++)
    s[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return s;
}

console.log("wav codec:");

check(
  "encode→decode preserves length, rate, mono; channelData has 1 channel",
  () => {
    const sr = 44100;
    const src = sine(440, sr, 4096);
    const { samples, sampleRate, channels, channelData } = decodeWav(
      encodeWav(src, sr),
    );
    assert.strictEqual(sampleRate, sr, "sample rate changed");
    assert.strictEqual(channels, 1, "not mono");
    assert.strictEqual(samples.length, src.length, "length changed");
    assert.strictEqual(
      channelData.length,
      1,
      "mono channelData should have 1 channel",
    );
  },
);

check("16-bit round-trip is near-lossless", () => {
  const src = sine(440, 44100, 2048);
  const { samples } = decodeWav(encodeWav(src, 44100));
  let maxErr = 0;
  for (let i = 0; i < src.length; i++)
    maxErr = Math.max(maxErr, Math.abs(src[i]! - samples[i]!));
  assert(maxErr < 1 / 16000, `round-trip error too high: ${maxErr}`); // ~2 LSB at 16-bit
});

check("decoded centroid ≈ tone frequency (the 'ear' reads the WAV)", () => {
  const sr = 44100;
  const { samples, sampleRate } = decodeWav(
    encodeWav(sine(1000, sr, 8192), sr),
  );
  const c = spectralCentroid(samples, sampleRate);
  assert(
    Math.abs(c - 1000) < 120,
    `centroid ${c.toFixed(0)} Hz not near 1000 Hz`,
  );
});

check("brighter tone → higher decoded centroid", () => {
  const sr = 44100;
  const lo = decodeWav(encodeWav(sine(500, sr, 8192), sr));
  const hi = decodeWav(encodeWav(sine(3000, sr, 8192), sr));
  assert(
    spectralCentroid(hi.samples, sr) > spectralCentroid(lo.samples, sr),
    "brighter tone did not measure brighter",
  );
});

console.log("stereo decode:");

check(
  "stereo WAV decodes to two channels; L/R recover and mono is their average",
  () => {
    const sr = 44100;
    const L = sine(440, sr, 4096, 0.8);
    const R = sine(660, sr, 4096, 0.5);
    const { samples, channels, channelData } = decodeWav(
      encodeWavStereo(L, R, sr),
    );
    assert.strictEqual(channels, 2, "not stereo");
    assert.strictEqual(
      channelData.length,
      2,
      "channelData should have 2 channels",
    );
    assert.strictEqual(channelData[0]!.length, L.length, "left length changed");
    let maxErrL = 0,
      maxErrR = 0,
      maxErrMono = 0;
    for (let i = 0; i < L.length; i++) {
      maxErrL = Math.max(maxErrL, Math.abs(channelData[0]![i]! - L[i]!));
      maxErrR = Math.max(maxErrR, Math.abs(channelData[1]![i]! - R[i]!));
      maxErrMono = Math.max(
        maxErrMono,
        Math.abs(samples[i]! - (L[i]! + R[i]!) / 2),
      );
    }
    assert(maxErrL < 1 / 16000, `left round-trip error ${maxErrL}`);
    assert(maxErrR < 1 / 16000, `right round-trip error ${maxErrR}`);
    assert(
      maxErrMono < 1 / 16000,
      `mono downmix not the channel average: ${maxErrMono}`,
    );
  },
);

console.log(`\n${pass} checks passed`);
