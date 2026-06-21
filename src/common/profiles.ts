// The synth profiles the engine ships with. Supporting a new synth = adding a profile here
// (control matchers, safe ranges, device matcher, region, metric bands) — the engine,
// recipes, adapters, MCP tools, and in-Live commands all read through it.

import type { SynthProfile } from "./registry.ts";

export const SERUM_PROFILE: SynthProfile = {
  id: "serum",
  label: "Xfer Serum",
  deviceMatch: "serum",
  defaultRegion: { startBeat: 0, endBeat: 4 },
  // Band edges tuned for a bass patch (55 Hz fundamental); see measure.ts.
  metricBands: { highHz: 600, bassHz: 150 },
  controls: [
    {
      id: "filter.cutoff",
      label: "Filter Cutoff",
      aliases: ["cutoff", "brightness"],
      match: /(filter\s*)?cut\s*off/i, // "A Cutoff", "Filter Cutoff", "Fil Cut Off"
      safe: [0.12, 0.88],
    },
    {
      id: "filter.reso",
      label: "Filter Resonance",
      aliases: ["resonance", "reso", "res"],
      match: /res(o|onance)?\b/i,
      safe: [0.0, 0.7],
    },
    {
      id: "fx.drive",
      label: "Drive",
      aliases: ["drive", "distortion", "dist", "grit"],
      match: /(drive|dist(ortion)?)/i,
      safe: [0.0, 0.85],
    },
    // Regexes below are first-guess tolerant matchers; the rig session captures Serum 2's
    // real Configure-Mode names (parameter_discovery_complete log) and adjusts them from
    // evidence.
    {
      id: "sub.level",
      label: "Sub Oscillator Level",
      aliases: ["sub", "sub level", "sub volume", "sub osc"],
      match: /sub.*(level|vol)/i, // "Sub Level", "Sub Osc Volume"
      safe: [0.0, 0.95],
    },
    {
      id: "osc.detune",
      label: "Unison Detune",
      aliases: ["detune", "unison detune", "unison", "width"],
      match: /(uni(son)?\s*)?det(une)?\b/i, // "A Unison Detune", "Det", "Detune"
      safe: [0.0, 0.6], // past ~0.6 unison detune stops being "wide" and starts being "out of tune"
    },
    {
      id: "lfo1.rate",
      label: "LFO 1 Rate",
      aliases: ["lfo rate", "lfo1 rate", "lfo 1 rate", "movement rate"],
      match: /lfo\s*1?\s*rate/i, // "LFO 1 Rate", "LFO1 Rate", "LFO Rate"
      safe: [0.05, 0.9],
    },
  ],
};

export const PROFILES: Record<string, SynthProfile> = {
  [SERUM_PROFILE.id]: SERUM_PROFILE,
};

export const DEFAULT_PROFILE = SERUM_PROFILE;

/** Look a profile up by id; omitted id returns the default. Throws listing what exists. */
export function getProfile(id?: string | undefined): SynthProfile {
  if (id == null || id === "") return DEFAULT_PROFILE;
  const p = PROFILES[id.toLowerCase()];
  if (!p) {
    throw new Error(
      `unknown synth profile "${id}" (available: ${Object.keys(PROFILES).join(", ")})`
    );
  }
  return p;
}
