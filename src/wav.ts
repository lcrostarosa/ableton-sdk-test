// Minimal WAV codec — just enough to turn the SDK's rendered .wav into a Float32 mono
// signal for spectralCentroid(), and to encode a known tone for round-trip tests.
// No dependencies. Handles PCM int (16/24/32-bit) and IEEE float (32-bit); downmixes to mono.
//
// The byte-level reads index a Buffer inside loops bounded by the data length, so they're
// always in range; `noUncheckedIndexedAccess` can't prove that, hence the `!` on the raw
// 24-bit byte reads.

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Mono downmix (channel average) — the unit the FFT-based metrics work in. */
  samples: Float32Array;
  /** Per-channel signals, length === channels. Stereo metrics (width/correlation/phase)
   *  read L/R from here; the mono downmix above can't express inter-channel relationships. */
  channelData: Float32Array[];
}

interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export function decodeWav(buf: Buffer | ArrayBuffer | Uint8Array): DecodedWav {
  // buf: Node Buffer or ArrayBuffer/Uint8Array of a RIFF/WAVE file.
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let fmt: WavFormat | null = null;
  let dataOffset = -1;
  let dataLength = 0;

  // Walk chunks starting after the 12-byte RIFF header.
  let p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLength = size;
    }
    p = body + size + (size & 1); // chunks are word-aligned
  }

  if (!fmt) throw new Error("missing fmt chunk");
  if (dataOffset < 0) throw new Error("missing data chunk");

  const { audioFormat, channels, bitsPerSample, sampleRate } = fmt;
  const bytesPerSample = bitsPerSample >> 3;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const mono = new Float32Array(frameCount);
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(new Float32Array(frameCount));

  const readSample = makeSampleReader(b, audioFormat, bitsPerSample);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const base = dataOffset + i * bytesPerSample * channels;
    for (let c = 0; c < channels; c++) {
      const s = readSample(base + c * bytesPerSample);
      channelData[c]![i] = s; // keep per-channel for stereo metrics
      sum += s;
    }
    mono[i] = sum / channels; // downmix
  }

  return { sampleRate, channels, samples: mono, channelData };
}

function makeSampleReader(b: Buffer, audioFormat: number, bits: number): (o: number) => number {
  if (audioFormat === 3 && bits === 32) {
    return (o) => b.readFloatLE(o);
  }
  if (audioFormat === 1) {
    if (bits === 16) return (o) => b.readInt16LE(o) / 32768;
    if (bits === 24) {
      return (o) => {
        // little-endian 24-bit signed
        let v = b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
        if (v & 0x800000) v |= ~0xffffff; // sign-extend
        return v / 8388608;
      };
    }
    if (bits === 32) return (o) => b.readInt32LE(o) / 2147483648;
  }
  throw new Error(`unsupported WAV format=${audioFormat} bits=${bits}`);
}

// Encode a mono Float32 signal to a 16-bit PCM WAV Buffer (used by tests).
export function encodeWav(samples: ArrayLike<number>, sampleRate = 44100): Buffer {
  const n = samples.length;
  const dataLen = n * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    b.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return b;
}

// Encode two mono Float32 channels into an interleaved 16-bit PCM stereo WAV (used by tests
// to exercise the stereo decode path and the stereo metrics).
export function encodeWavStereo(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  sampleRate = 44100
): Buffer {
  const n = Math.min(left.length, right.length);
  const dataLen = n * 2 * 2; // 2 channels × 16-bit
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(2, 22); // stereo
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 4, 28); // byte rate (2ch × 2 bytes)
  b.writeUInt16LE(4, 32); // block align (2ch × 2 bytes)
  b.writeUInt16LE(16, 34); // bits
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  const clip = (x: number) => Math.max(-1, Math.min(1, x));
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(clip(left[i]!) * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(clip(right[i]!) * 32767), 44 + i * 4 + 2);
  }
  return b;
}
