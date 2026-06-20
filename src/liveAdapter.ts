// LiveAdapter is a RecipeAdapter backed by Ableton's Extensions SDK.
// It implements the same get/set/measure/safeOf contract the engine expects, so the
// recipes and measurement code stay unchanged while the backend varies.
//
// Architecture (per the approved plan):
//   - param control  : DeviceParameter.getValue()/setValue()  (works for ANY device on the
//                       track, third-party included; only insertDevice is built-in-only)
//   - audio capture  : Resources.renderPreFxAudio(renderTrack, startBeat, endBeat) -> WAV.
//                       renderPreFxAudio is AudioTrack-ONLY (Spike B): rendering the synth's
//                       MIDI track itself rejects with a bare `undefined`. The ears are a
//                       separate, manually-routed audio track (by convention named "AI Ear")
//                       that monitors the synth's output; `create` resolves it from the Song.
//   - measurement    : decodeWav() -> measureAPO()  (banded per the synth profile)
//
// WHICH synth is entirely the profile's business (registry.ts/profiles.ts): the profile
// carries the device matcher, the control matchers, and the safe ranges. Controls resolve
// lazily on first get/set, so an unexposed parameter only fails the recipe that needs it
// (with a Configure-Mode hint), never adapter construction.
//
// All SDK calls are async, so this adapter's methods are async → drive it with
// `applyRecipe` (intentEngine.ts), which awaits every adapter call.
//
// Types here are the real `@ableton-extensions/sdk` types (type-only imports, no runtime
// dependency on the host). Tests supply fixture objects and doubles that are cast to these
// same SDK types, so the adapter is typechecked against the host's actual surface.

import { measureScalar } from "./measure.ts";
import { decodeWav } from "./wav.ts";
import { byId, safeOf } from "./registry.ts";
import { SERUM_PROFILE } from "./profiles.ts";
import type {
  ApiVersion,
  AudioTrack,
  Device,
  DeviceParameter,
  ExtensionContext,
  Song,
  Track,
} from "@ableton-extensions/sdk";
import type { Range, Region, SynthProfile } from "./registry.ts";
import type { RecipeAdapter } from "./intentEngine.ts";
import type { ScalarAPO } from "./measure.ts";

export type { Region } from "./registry.ts";

// The SDK currently ships exactly one API version ("1.0.0"); pin every object type to it.
type V = ApiVersion;

// Convenience aliases — the real SDK types, version-applied. Consumers (the MCP kernel,
// the extension) import these instead of redeclaring lookalike interfaces.
export type SdkTrack = Track<V>;
export type SdkAudioTrack = AudioTrack<V>;
export type SdkDevice = Device<V>;
export type SdkDeviceParameter = DeviceParameter<V>;
export type SdkSong = Song<V>;
export type SdkResources = ExtensionContext<V>["resources"];
/** The slice of ExtensionContext the adapter needs. */
export type SdkContext = Pick<ExtensionContext<V>, "resources">;

// The slice of node 'fs' the adapter needs (callers pass the real module; tests may stub it).
export type FsLike = Pick<typeof import("node:fs"), "readFileSync">;

// The default name convention for the routed ear track (see aiEarSetupError below).
export const RENDER_TRACK_NAME = "AI Ear";

interface NormParam {
  param: SdkDeviceParameter;
  min: number;
  max: number;
}

interface LiveAdapterDeps {
  resources: SdkResources;
  track: SdkTrack;
  renderTrack?: SdkAudioTrack | undefined;
  device: SdkDevice;
  region: Region;
  fs: FsLike;
  profile?: SynthProfile | undefined;
  sampleRate?: number | undefined;
}

interface CreateArgs {
  context: SdkContext;
  /** The track the synth lives on (params are controlled here). */
  track: SdkTrack;
  /** The Live Set; used to resolve the render track by name when `renderTrack` is absent. */
  song?: SdkSong | undefined;
  /** Explicit ear track; skips the by-name resolution. */
  renderTrack?: SdkAudioTrack | undefined;
  /** Case-insensitive substring for the ear track's name. Default "AI Ear". */
  renderTrackMatch?: string;
  /** Which synth this adapter drives (controls, safe ranges, device matcher). */
  profile?: SynthProfile;
  /** Override the profile's device matcher (case-insensitive substring). */
  deviceMatch?: string | undefined;
  region: Region;
  fs: FsLike;
  sampleRate?: number | undefined;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function normRange(p: SdkDeviceParameter): NormParam {
  if (!(p.max > p.min)) throw new Error(`param "${p.name}" has bad range min=${p.min} max=${p.max}`);
  return { param: p, min: p.min, max: p.max };
}

/**
 * Find the synth's device on a track by case-insensitive name substring, falling back to
 * the first device. Shared by LiveAdapter.create and the MCP kernel handlers.
 */
export function resolveDevice(track: SdkTrack, match: string): SdkDevice {
  const devices = track.devices;
  const device =
    devices.find((d) => d.name.toLowerCase().includes(match.toLowerCase())) || devices[0];
  if (!device) throw new Error(`no devices on track "${track.name}"`);
  return device;
}

// The one-time routing setup the system asks the user for when the ear track is missing.
export function aiEarSetupError(match: string, trackNames: string[]): Error {
  return new Error(
    `no audio track matching "${match}" found to render from (tracks: [${trackNames.join(", ")}]). ` +
    `renderPreFxAudio only renders AudioTracks, so the ear is a routed audio track monitoring ` +
    `the synth. One-time setup in Live: (1) create an audio track and name it "${match}"; ` +
    `(2) set its "Audio From" to the synth's track; (3) set Monitor to "In"; then retry.`
  );
}

// SDK objects carry their Live class on the constructor (static className). Real MIDI
// tracks must not be used as the ear even if named like it; unknown shapes (tests, future
// SDK versions) fall through to the name convention + render probe.
function isKnownNonAudioTrack(t: SdkTrack): boolean {
  const cls = (t.constructor as { className?: unknown } | undefined)?.className;
  return typeof cls === "string" && cls !== "AudioTrack";
}

export class LiveAdapter implements RecipeAdapter {
  resources: SdkResources;
  track: SdkTrack;
  renderTrack: SdkAudioTrack | undefined;
  device: SdkDevice;
  region: Region;
  fs: FsLike;
  profile: SynthProfile;
  sampleRate: number;
  private _cache: Record<string, NormParam>;

  /**
   * Prefer the async factory `LiveAdapter.create(...)` which resolves the device and the
   * render track for you. Direct construction is for when you already hold them.
   */
  constructor({ resources, track, renderTrack, device, region, fs, profile = SERUM_PROFILE, sampleRate = 44100 }: LiveAdapterDeps) {
    this.resources = resources;
    this.track = track;             // the synth's track — parameter control plane
    this.renderTrack = renderTrack; // the routed ear track — audio capture plane
    this.device = device;           // the synth device; controls resolve against it on demand
    this.region = region;
    this.fs = fs;
    this.profile = profile;
    this.sampleRate = sampleRate;
    this._cache = {}; // id -> { param, min, max }
  }

  /**
   * Resolve the synth device on the track (by the profile's device matcher), resolve the
   * routed ear track from the Song, then build the adapter. Control parameters resolve
   * lazily on first use, so construction never depends on which params are exposed.
   */
  static async create({
    context, track, song, renderTrack, renderTrackMatch = RENDER_TRACK_NAME,
    profile = SERUM_PROFILE, deviceMatch, region, fs, sampleRate,
  }: CreateArgs): Promise<LiveAdapter> {
    const device = resolveDevice(track, deviceMatch ?? profile.deviceMatch);

    // Resolve the ear: explicit renderTrack wins; otherwise find the "AI Ear" audio track
    // in the Song by name convention. With neither, fall back to rendering the device
    // track itself (back-compat) — on a MIDI track that fails with the actionable Spike-B
    // error at measure time.
    let ear = renderTrack;
    if (!ear && song) {
      const tracks = song.tracks;
      const found = tracks.find((t) =>
        t.name.toLowerCase().includes(renderTrackMatch.toLowerCase())
      );
      if (!found) throw aiEarSetupError(renderTrackMatch, tracks.map((t) => t.name));
      if (isKnownNonAudioTrack(found)) {
        throw new Error(
          `track "${found.name}" matches "${renderTrackMatch}" but is not an audio track — ` +
          `renderPreFxAudio can only render AudioTracks. Rename or recreate it as an audio ` +
          `track routed from the synth (Audio From = synth track, Monitor = In).`
        );
      }
      ear = found as SdkAudioTrack;
    }

    return new LiveAdapter({
      resources: context.resources, track, renderTrack: ear, device, region, fs, profile, sampleRate,
    });
  }

  // Resolve a profile control id (e.g. "fx.drive") to its DeviceParameter on this device,
  // by matching the profile's name regex against the exposed param names. Cached.
  private async _resolve(id: string): Promise<NormParam> {
    const cached = this._cache[id];
    if (cached) return cached;
    const control = byId(this.profile, id);
    const params = this.device.parameters;
    // Lowercase the param name explicitly so the match never depends on the regex /i alone.
    const p = params.find((pp) => control.match.test(pp.name.toLowerCase()));
    if (!p) {
      const names = params.map((pp) => pp.name).join(", ");
      throw new Error(
        `no parameter for "${id}" (${control.label}) on "${this.device.name}". ` +
        `Exposed: [${names}]. Expose it via Live's Configure Mode, then retry.`
      );
    }
    return (this._cache[id] = normRange(p));
  }

  // Resolve every given control id, partitioning into found/missing — the spec-§7 startup
  // exposure check (ableton_list_sound_controls reports `missing` with Configure-Mode help).
  async resolveControls(ids: string[]): Promise<{
    found: { id: string; paramName: string; min: number; max: number; value: number }[];
    missing: { id: string; label: string; error: string }[];
  }> {
    const found: { id: string; paramName: string; min: number; max: number; value: number }[] = [];
    const missing: { id: string; label: string; error: string }[] = [];
    for (const id of ids) {
      try {
        const { param, min, max } = await this._resolve(id);
        const value = (await param.getValue() - min) / (max - min);
        found.push({ id, paramName: param.name, min, max, value });
      } catch (e) {
        missing.push({
          id,
          label: byId(this.profile, id).label,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { found, missing };
  }

  // --- the generic RecipeAdapter contract (used by intentEngine.ts / applyRecipe) ---

  // normalized 0..1, the unit the engine works in (the profile's safe ranges stay valid)
  async get(id: string): Promise<number> {
    const { param, min, max } = await this._resolve(id);
    return ((await param.getValue()) - min) / (max - min);
  }

  async set(id: string, n: number): Promise<void> {
    const { param, min, max } = await this._resolve(id);
    await param.setValue(min + clamp01(n) * (max - min));
  }

  safeOf(id: string): Range {
    return safeOf(this.profile, id);
  }

  // Render once, decode, return the scalar APO (the convergence loop's targetable metrics;
  // the spectrogram grid is only built at the render_audio perception endpoint).
  async measure(): Promise<ScalarAPO> {
    const { samples, sampleRate, channelData } = await this._render();
    return measureScalar(samples, sampleRate || this.sampleRate, {
      bands: this.profile.metricBands,
      channelData,
    });
  }

  private async _render(): Promise<{ sampleRate: number; channels: number; samples: Float32Array; channelData: Float32Array[] }> {
    // Render from the routed ear track when configured; otherwise from the device track
    // (back-compat — valid only when the device sits on an AudioTrack, hence the cast).
    const lane = this.renderTrack ?? (this.track as SdkAudioTrack);
    let wavPath: string;
    try {
      wavPath = await this.resources.renderPreFxAudio(
        lane,
        this.region.startBeat,
        this.region.endBeat
      );
    } catch (e) {
      // The SDK's renderPreFxAudio takes an AudioTrack only — calling it on a MidiTrack
      // (where the synth lives) makes the native bridge reject with no error info at all
      // (a bare `undefined`), which otherwise surfaces as an opaque "undefined" in the
      // log. Spike B (README "Two spikes first") called this exact failure mode; the fix
      // is the routed "AI Ear" audio track resolved by LiveAdapter.create.
      if (e === undefined || e === null) {
        throw new Error(
          `renderPreFxAudio rejected with no error info — the render lane is a ` +
          `MIDI/instrument track, and renderPreFxAudio only renders AudioTrack arrangement ` +
          `audio. Route an audio track from the synth and name it "${RENDER_TRACK_NAME}" ` +
          `(Audio From = synth track, Monitor = In), then retry; see extension/README.md.`
        );
      }
      throw e;
    }
    const buf = this.fs.readFileSync(wavPath);
    return decodeWav(buf);
  }
}
