// Kernel method handlers — the ONLY place Live API calls happen in the MCP stack.
// Each handler takes already-parsed params and returns a JSON-safe result; extension.ts
// dispatches bridge requests here. The sound-intent handlers reuse the portable engine
// (ideas/demo/src/*) through LiveAdapter, so the MCP surface and the in-Live context-menu
// commands run the IDENTICAL closed loop.
//
// Every handler is synth-agnostic: the optional `synth` param selects a SynthProfile
// (profiles.ts), which supplies the device matcher, the control registry, the default
// measurement region, and the metric bands. Supporting a new synth is a new profile.

import fs from "node:fs";
import { LiveAdapter, RENDER_TRACK_NAME, resolveDevice } from "../common/liveAdapter.ts";
import type { SdkAudioTrack, SdkSong, SdkTrack } from "../common/liveAdapter.ts";
import { applyRecipe } from "../common/intentEngine.ts";
import type { RecipeResult } from "../common/intentEngine.ts";
import { makeRandomProposer } from "../common/proposers.ts";
import { RECIPES } from "../common/recipes.ts";
import { checkExposure } from "../common/registry.ts";
import type { Region, SynthProfile } from "../common/registry.ts";
import { PROFILES, getProfile } from "../common/profiles.ts";
import { measureFull } from "../common/measure.ts";
import { decodeWav } from "../common/wav.ts";

// The slice of ExtensionContext the handlers need (resources for rendering; the Song comes
// via a getter so each request reads Live's current state, never a stale snapshot).
export interface KernelEnv {
  resources: Parameters<typeof LiveAdapter.create>[0]["context"]["resources"];
  getSong(): SdkSong;
}

export interface TrackRefParams {
  trackIndex?: number | undefined;
  trackName?: string | undefined;
}

interface RegionParams {
  startBeat?: number | undefined;
  endBeat?: number | undefined;
}

interface SynthParams {
  synth?: string | undefined;
  deviceMatch?: string | undefined;
}

function trackClass(t: SdkTrack): string {
  const cls = (t.constructor as { className?: unknown } | undefined)?.className;
  return typeof cls === "string" ? cls : "Track";
}

function resolveTrack(
  song: SdkSong,
  ref: TrackRefParams,
  profile: SynthProfile
): { track: SdkTrack; index: number } {
  const tracks = song.tracks;
  if (ref.trackIndex != null) {
    const track = tracks[ref.trackIndex];
    if (!track) throw new Error(`trackIndex ${ref.trackIndex} out of range (0..${tracks.length - 1})`);
    return { track, index: ref.trackIndex };
  }
  if (ref.trackName) {
    const q = ref.trackName.toLowerCase();
    const index = tracks.findIndex((t) => t.name.toLowerCase().includes(q));
    if (index < 0) {
      throw new Error(
        `no track matching "${ref.trackName}" (tracks: [${tracks.map((t) => t.name).join(", ")}])`
      );
    }
    return { track: tracks[index]!, index };
  }
  // default: the first track carrying a device that matches the profile's synth
  const match = profile.deviceMatch.toLowerCase();
  const index = tracks.findIndex((t) =>
    t.devices.some((d) => d.name.toLowerCase().includes(match))
  );
  if (index < 0) {
    throw new Error(
      `no trackIndex/trackName given and no track has a "${profile.deviceMatch}" device ` +
      `(synth profile "${profile.id}")`
    );
  }
  return { track: tracks[index]!, index };
}

function region(p: RegionParams, profile: SynthProfile): Region {
  return {
    startBeat: p.startBeat ?? profile.defaultRegion.startBeat,
    endBeat: p.endBeat ?? profile.defaultRegion.endBeat,
  };
}

// Revert snapshots from apply_sound_intent, keyed by token. Bounded so a long session
// can't grow without limit.
interface RevertEntry {
  token: string;
  trackIndex: number;
  synth: string;
  deviceMatch: string | undefined;
  recipe: string;
  snapshot: Record<string, number>;
}
const REVERT_LOG_MAX = 32;

export function makeHandlers(env: KernelEnv) {
  // per-instance state (a second makeHandlers must never share another bridge's edits)
  const revertLog: RevertEntry[] = [];
  let revertSeq = 0;

  async function adapterFor(
    ref: TrackRefParams & RegionParams & SynthParams,
    opts: { needsEar: boolean }
  ): Promise<{ adapter: LiveAdapter; trackIndex: number; profile: SynthProfile }> {
    const profile = getProfile(ref.synth);
    const song = env.getSong();
    const { track, index } = resolveTrack(song, ref, profile);
    const adapter = await LiveAdapter.create({
      context: { resources: env.resources },
      track,
      // open-loop intents never render, so they must not fail on a missing "AI Ear" track
      ...(opts.needsEar ? { song } : {}),
      profile,
      deviceMatch: ref.deviceMatch,
      region: region(ref, profile),
      fs,
    });
    return { adapter, trackIndex: index, profile };
  }

  return {
    // --- generic Live perception (bounded, summary-first) ---

    async get_context(): Promise<unknown> {
      const song = env.getSong();
      return {
        tempo: song.tempo,
        tracks: song.tracks.map((t, index) => ({
          index,
          name: t.name,
          type: trackClass(t),
          devices: t.devices.map((d) => d.name),
        })),
        renderTrackConvention: RENDER_TRACK_NAME,
        synthProfiles: Object.values(PROFILES).map((p) => ({
          id: p.id,
          label: p.label,
          deviceMatch: p.deviceMatch,
          controls: p.controls.map((c) => c.id),
        })),
      };
    },

    async get_track(params: TrackRefParams & SynthParams): Promise<unknown> {
      const profile = getProfile(params.synth);
      const { track, index } = resolveTrack(env.getSong(), params, profile);
      return {
        index,
        name: track.name,
        type: trackClass(track),
        devices: track.devices.map((d, deviceIndex) => ({
          deviceIndex,
          name: d.name,
          parameterCount: d.parameters.length,
        })),
      };
    },

    async get_device(
      params: TrackRefParams & SynthParams & { maxParams?: number | undefined; includeValues?: boolean | undefined }
    ): Promise<unknown> {
      const profile = getProfile(params.synth);
      const { track } = resolveTrack(env.getSong(), params, profile);
      const device = resolveDevice(track, params.deviceMatch ?? profile.deviceMatch);
      const max = Math.min(params.maxParams ?? 64, 256);
      const all = device.parameters;
      const slice = all.slice(0, max);
      const parameters = [];
      for (const p of slice) {
        parameters.push({
          name: p.name,
          min: p.min,
          max: p.max,
          isQuantized: p.isQuantized,
          ...(params.includeValues ? { value: await p.getValue() } : {}),
        });
      }
      return {
        name: device.name,
        parameterCount: all.length,
        truncated: all.length > slice.length,
        parameters,
      };
    },

    async render_audio(params: TrackRefParams & RegionParams & SynthParams): Promise<unknown> {
      const profile = getProfile(params.synth);
      const song = env.getSong();
      const { track } = resolveTrack(song, params, profile);
      const r = region(params, profile);
      const wavPath = await env.resources.renderPreFxAudio(
        track as SdkAudioTrack, // AudioTrack-only at runtime; MIDI tracks reject (Spike B)
        r.startBeat,
        r.endBeat
      );
      const { samples, sampleRate, channelData } = decodeWav(fs.readFileSync(wavPath));
      return {
        wavPath,
        sampleRate,
        samples: samples.length,
        // Full APO at the perception endpoint: scalar metrics (incl. real stereo from
        // channelData) plus the coarse spectrogram grid.
        apo: measureFull(samples, sampleRate, { bands: profile.metricBands, channelData }),
      };
    },

    // --- the sound-intent surface (the L3 recipe contract; Claude is the L4 planner) ---

    async list_sound_controls(params: TrackRefParams & SynthParams): Promise<unknown> {
      const profile = getProfile(params.synth);
      const { track, index } = resolveTrack(env.getSong(), params, profile);
      const device = resolveDevice(track, params.deviceMatch ?? profile.deviceMatch);
      const exposure = checkExposure(profile, device.parameters.map((p) => p.name));
      // attach current normalized values to the resolved controls
      const found = [];
      for (const f of exposure.found) {
        const p = device.parameters.find((pp) => pp.name === f.paramName)!;
        const value = (await p.getValue() - p.min) / (p.max - p.min);
        found.push({ ...f, value });
      }
      return {
        trackIndex: index,
        synth: profile.id,
        device: device.name,
        found,
        missing: exposure.missing.map((m) => ({
          ...m,
          fix: `Expose a "${m.label}" parameter via Live's Configure Mode on ${device.name} (click Configure, touch the knob in the plugin UI), then retry.`,
        })),
        registrySize: profile.controls.length,
      };
    },

    async apply_sound_intent(
      params: TrackRefParams &
        RegionParams &
        SynthParams & {
          recipeId?: string | undefined;
          intensity?: number | undefined;
          maxIters?: number | undefined;
          seed?: number | undefined;
        }
    ): Promise<unknown> {
      const recipe = params.recipeId != null ? RECIPES[params.recipeId] : undefined;
      if (!recipe) {
        throw new Error(
          `unknown recipeId "${params.recipeId}" (valid: ${Object.keys(RECIPES).join(", ")})`
        );
      }
      const needsEar = recipe.metric != null;
      const { adapter, trackIndex, profile } = await adapterFor(params, { needsEar });

      // "explore" (or any recipe given an explicit seed) runs the seeded random proposer —
      // non-deterministic by design, reproducible by seed, same safety harness.
      const seed =
        params.seed ?? (recipe.id === "explore" ? Date.now() >>> 0 : undefined);
      const result: RecipeResult = await applyRecipe(adapter, recipe, {
        ...(params.intensity != null ? { intensity: params.intensity } : {}),
        ...(params.maxIters != null ? { maxIters: params.maxIters } : {}),
        ...(seed != null ? { proposer: makeRandomProposer({ seed }) } : {}),
      });

      const token = `edit-${++revertSeq}`;
      revertLog.push({
        token,
        trackIndex,
        synth: profile.id,
        deviceMatch: params.deviceMatch,
        recipe: recipe.id,
        snapshot: result.snapshot,
      });
      if (revertLog.length > REVERT_LOG_MAX) revertLog.shift();

      // strip the function before serializing; revert goes through revert_sound_intent
      const { revert: _revert, ...payload } = result;
      return { ...payload, ...(seed != null ? { seed } : {}), revertToken: token };
    },

    async revert_sound_intent(params: { token?: string | undefined }): Promise<unknown> {
      const entry = params.token != null
        ? revertLog.find((e) => e.token === params.token)
        : revertLog[revertLog.length - 1];
      if (!entry) {
        throw new Error(
          params.token != null
            ? `no revert entry for token "${params.token}"`
            : "nothing to revert — no sound intent has been applied this session"
        );
      }
      const { adapter } = await adapterFor(
        { trackIndex: entry.trackIndex, synth: entry.synth, deviceMatch: entry.deviceMatch },
        { needsEar: false } // setting params back needs no render
      );
      const restored: Record<string, number> = {};
      for (const [id, v] of Object.entries(entry.snapshot)) {
        await adapter.set(id, v);
        restored[id] = v;
      }
      revertLog.splice(revertLog.indexOf(entry), 1);
      return { token: entry.token, recipe: entry.recipe, restored };
    },

    // --- escape hatch (advanced/destructive; not the path for sound workflows) ---

    async run_code(params: { code?: string | undefined }): Promise<unknown> {
      if (!params.code) throw new Error("run_code requires { code }");
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
        ...args: string[]
      ) => (...fnArgs: unknown[]) => Promise<unknown>;
      const fn = new AsyncFunction("song", "resources", "fs", params.code);
      const value = await fn(env.getSong(), env.resources, fs);
      // results must survive JSON serialization; fall back to String for host objects
      try {
        return JSON.parse(JSON.stringify(value) ?? '"undefined"');
      } catch {
        return String(value);
      }
    },
  };
}

export type Handlers = ReturnType<typeof makeHandlers>;
