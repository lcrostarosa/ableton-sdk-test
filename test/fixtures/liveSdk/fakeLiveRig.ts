import fs from "node:fs";
import { RENDER_TRACK_NAME } from "../../../src/common/liveAdapter.ts";
import type {
  SdkAudioTrack,
  SdkContext,
  SdkDevice,
  SdkDeviceParameter,
  SdkResources,
  SdkSong,
  SdkTrack,
} from "../../../src/common/liveAdapter.ts";
import { encodeWav } from "../../../src/common/wav.ts";
import { FakeSerum } from "../audio/fakeSerum.ts";

export function fakeParam(name: string, min: number, max: number, value: number): SdkDeviceParameter {
  let v = value;
  return {
    name, min, max,
    getValue: async () => v,
    setValue: async (x: number) => { v = x; },
  } as unknown as SdkDeviceParameter;
}

export function fakeDevice(name: string, params: () => SdkDeviceParameter[]): SdkDevice {
  return { name, get parameters() { return params(); } } as unknown as SdkDevice;
}

export function fakeTrack(name: string, devices: SdkDevice[] = []): SdkTrack {
  return { name, get devices() { return devices; } } as unknown as SdkTrack;
}

export class FakeMidiTrackShape {
  static readonly className = "MidiTrack";
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  get devices(): SdkDevice[] {
    return [];
  }
}

export interface FakeRig {
  context: SdkContext;
  track: SdkTrack;
  song: SdkSong;
  renderedTracks: string[];
}

export function makeFakeRig(tmpWav: string, opts: { earName?: string | null } = {}): FakeRig {
  const earName = opts.earName === undefined ? RENDER_TRACK_NAME : opts.earName;
  const synth = new FakeSerum({ f0: 55, sampleRate: 44100, durationSec: 0.3 });
  const cutoff = fakeParam("A Cutoff", 0, 1, 0.45);
  const drive = fakeParam("Drive", 0, 1, 0.0);
  const reso = fakeParam("A Resonance", 0, 1, 0.1);
  const sub = fakeParam("Sub Level", 0, 1, 0.0);
  const detune = fakeParam("A Unison Detune", 0, 1, 0.0);
  const device = fakeDevice("Serum2", () => [
    fakeParam("A Octave", -4, 4, 0), cutoff, fakeParam("A Cutoff Mod", 0, 1, 0), drive, reso, sub, detune,
  ]);
  const track = fakeTrack("Serum Bass", [device]);
  const earTrack = earName != null ? fakeTrack(earName) : null;
  const tracks = earTrack ? [track, earTrack] : [track];
  const song = { get tracks() { return tracks; } } as unknown as SdkSong;

  const renderedTracks: string[] = [];
  const resources = {
    renderPreFxAudio: async (lane: SdkAudioTrack, _start: number, _end: number) => {
      renderedTracks.push(lane.name);
      synth.setCutoff(await cutoff.getValue());
      synth.setDrive(await drive.getValue());
      synth.setReso(await reso.getValue());
      synth.setSubLevel(await sub.getValue());
      synth.setDetune(await detune.getValue());
      const raw = synth.render();
      const scaled = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) scaled[i] = raw[i]! * 0.4;
      const wav = encodeWav(scaled, synth.sampleRate);
      fs.writeFileSync(tmpWav, wav);
      return tmpWav;
    },
  } as unknown as SdkResources;

  return { context: { resources }, track, song, renderedTracks };
}
