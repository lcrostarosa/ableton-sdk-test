import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHandlers } from "../../../extension/ableton-sdk-mcp/kernel/src/handlers.ts";
import { FakeSerum } from "../audio/fakeSerum.ts";
import { encodeWav } from "../../../src/wav.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-test-"));
const tmpWav = path.join(tmpDir, "render.wav");

export function fakeParam(name, min, max, value) {
  let v = value;
  return { name, min, max, isQuantized: false, getValue: async () => v, setValue: async (x) => { v = x; } };
}

export function makeRig({ withEar = true, withLfo = false } = {}) {
  const synth = new FakeSerum({ f0: 55, sampleRate: 44100, durationSec: 0.3 });
  const params = {
    cutoff: fakeParam("A Cutoff", 0, 1, 0.45),
    drive: fakeParam("Drive", 0, 1, 0.0),
    reso: fakeParam("A Resonance", 0, 1, 0.1),
    sub: fakeParam("Sub Level", 0, 1, 0.0),
    detune: fakeParam("A Unison Detune", 0, 1, 0.0),
  };
  // The LFO is unexposed by default (so list_sound_controls can prove the missing-param path);
  // tests that need every `explore` control to resolve opt in with { withLfo: true }.
  if (withLfo) params.lfoRate = fakeParam("LFO 1 Rate", 0, 1, 0.2);
  const device = { name: "Serum2", get parameters() { return Object.values(params); } };
  const serumTrack = { name: "Serum Bass", get devices() { return [device]; } };
  const earTrack = { name: "AI Ear", get devices() { return []; } };
  const drumTrack = { name: "Drums", get devices() { return [{ name: "Drum Rack", get parameters() { return []; } }]; } };
  const tracks = withEar ? [drumTrack, serumTrack, earTrack] : [drumTrack, serumTrack];
  const song = { tempo: 120, get tracks() { return tracks; } };
  const resources = {
    renderPreFxAudio: async (lane) => {
      if (lane !== earTrack) throw undefined;
      synth.setCutoff(await params.cutoff.getValue());
      synth.setDrive(await params.drive.getValue());
      synth.setReso(await params.reso.getValue());
      synth.setSubLevel(await params.sub.getValue());
      synth.setDetune(await params.detune.getValue());
      const raw = synth.render();
      const scaled = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) scaled[i] = raw[i] * 0.4;
      fs.writeFileSync(tmpWav, encodeWav(scaled, synth.sampleRate));
      return tmpWav;
    },
  };
  return { handlers: makeHandlers({ resources, getSong: () => song }), params };
}

export function cleanupFakeKernelRig() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
