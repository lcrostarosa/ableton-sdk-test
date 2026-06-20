// Synth profiles — the single source of truth that maps a friendly control id to:
//   - how to find it on a real device (name matcher, tolerant of the synth's naming)
//   - its safe operating range (clamp), so no recipe can drive it to an unmusical extreme
// plus everything else that binds the engine to ONE synth: which device names count as
// that synth, where its measurement region sits, and how its spectrum is banded.
//
// Recipes reference controls by `id`; adapters read `safe` from their profile. This is the
// seam that lets "any knob on any synth" be reachable — supporting a new synth is a new
// SynthProfile (see profiles.ts), not new code. Every helper here is a pure function over
// a profile; nothing in this module is synth-specific.

import type { MetricBands } from "./measure.ts";

// A safe operating range, [lo, hi], in the normalized 0..1 unit the engine works in.
export type Range = [number, number];

// An arrangement region in beats (where the measured one-note clip lives).
export interface Region {
  startBeat: number;
  endBeat: number;
}

export interface ControlDef {
  id: string;
  label: string;
  aliases: string[];
  match: RegExp;
  safe: Range;
}

// Everything the engine/adapters/MCP need to know about one synth.
export interface SynthProfile {
  /** Stable id, e.g. "serum" — the MCP `synth` parameter selects by this. */
  id: string;
  /** Human-readable name, e.g. "Xfer Serum". */
  label: string;
  /** Case-insensitive substring that finds the synth's device on a track. */
  deviceMatch: string;
  controls: ControlDef[];
  /** Default arrangement region the ear measures (a sustained one-note clip lives here). */
  defaultRegion: Region;
  /** Spectrum band edges for the APO's high/bass energy ratios (patch-type dependent). */
  metricBands: MetricBands;
}

export const byId = (profile: SynthProfile, id: string): ControlDef => {
  const c = profile.controls.find((c) => c.id === id);
  if (!c) throw new Error(`unknown control id "${id}" for synth "${profile.id}"`);
  return c;
};

export const safeOf = (profile: SynthProfile, id: string): Range => byId(profile, id).safe;

// Friendly text -> control (id or alias, case-insensitive). Returns null if no match.
export const resolveAlias = (profile: SynthProfile, name: string): ControlDef | null => {
  const q = name.toLowerCase();
  return (
    profile.controls.find((c) => c.id === q || c.aliases.some((a) => a === q)) ||
    profile.controls.find((c) => c.match.test(name)) ||
    null
  );
};

// The spec-§7 exposure check, as a pure function over a device's exposed parameter names:
// which profile controls resolve, which don't (→ user must expose them in Configure Mode).
// LiveAdapter.resolveControls does the same against live params; this needs no adapter (and
// so still works when even cutoff is missing).
export interface ExposureReport {
  found: { id: string; label: string; paramName: string }[];
  missing: { id: string; label: string; expects: string }[];
}

export function checkExposure(profile: SynthProfile, paramNames: string[]): ExposureReport {
  const report: ExposureReport = { found: [], missing: [] };
  for (const c of profile.controls) {
    const name = paramNames.find((n) => c.match.test(n.toLowerCase()));
    if (name !== undefined) report.found.push({ id: c.id, label: c.label, paramName: name });
    else report.missing.push({ id: c.id, label: c.label, expects: String(c.match) });
  }
  return report;
}
