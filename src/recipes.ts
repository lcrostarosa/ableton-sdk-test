// Recipes as DATA — the layer between an intent ("more aggressive") and the controls.
// A recipe says: push these controls in this direction, until this measured metric moves by
// targetRatio, without violating these invariants. The engine (intentEngine.ts) is generic;
// all the per-intent knowledge lives here, so new intents are data, not code.
//
//   metric      : APO field to drive (centroid | highRatio | bassRatio | rms).
//                 OMITTED for open-loop recipes (wider/movement): no APO metric can verify
//                 them in v1, so the engine applies the controls and reports param deltas.
//   targetRatio : stop when metric crosses before * targetRatio. > 1 drives the metric UP
//                 (brighter), < 1 drives it DOWN (darker). Required when metric is set.
//   controls    : [{ id, dir(+1/-1), step }]  — ids resolve through registry.ts (safe ranges)
//   constraints : [{ metric, maxRatio?, minRatio? }] — invariants: revert the step if metric
//                 leaves [before*minRatio, before*maxRatio] (e.g. keep loudness from
//                 exploding under heavy drive, or keep the low end from collapsing).
//   intensity   : default step scaling (0..1). Callers (the LLM planner) override per run.

import type { Metric } from "./measure.ts";

export interface Control {
  id: string;
  dir: 1 | -1;
  step: number;
}

export interface Constraint {
  metric: Metric;
  maxRatio?: number;
  minRatio?: number;
}

export interface Recipe {
  id: string;
  /** What this recipe means, for the LLM planner choosing among recipes. */
  description: string;
  metric?: Metric;
  targetRatio?: number;
  /** Additive floor on the convergence target, in the metric's own units. Guards metrics
   *  that can sit near zero (stereoWidth/flux) where `before*targetRatio ≈ 0` would make the
   *  target instantly "met" or unmovable. Optional; defaults to 0 (pure multiplicative). */
  minDelta?: number;
  controls: Control[];
  constraints?: Constraint[];
  intensity?: number;
}

export const RECIPES: Record<string, Recipe> = {
  brighter: {
    id: "brighter",
    description: "Open the filter for a brighter, more present tone (raises spectral centroid).",
    metric: "centroid",
    targetRatio: 1.25,
    controls: [{ id: "filter.cutoff", dir: +1, step: 0.08 }],
  },
  darker: {
    id: "darker",
    description: "Close the filter for a darker, warmer tone (lowers spectral centroid).",
    metric: "centroid",
    targetRatio: 0.8,
    controls: [{ id: "filter.cutoff", dir: -1, step: 0.08 }],
  },
  moreBass: {
    id: "moreBass",
    description: "Raise the sub oscillator (with a slight filter close) for more low end.",
    metric: "bassRatio",
    targetRatio: 1.4,
    controls: [
      { id: "sub.level", dir: +1, step: 0.12 },
      { id: "filter.cutoff", dir: -1, step: 0.03 },
    ],
    constraints: [{ metric: "rms", maxRatio: 2.5 }], // more bass, not just louder
  },
  lessBass: {
    id: "lessBass",
    description: "Pull the sub oscillator back (with a slight filter open) for a leaner low end.",
    metric: "bassRatio",
    targetRatio: 0.7,
    controls: [
      { id: "sub.level", dir: -1, step: 0.12 },
      { id: "filter.cutoff", dir: +1, step: 0.03 },
    ],
  },
  aggressive: {
    id: "aggressive",
    description: "Add drive and resonance for a harder, dirtier tone (raises high-band energy).",
    metric: "highRatio", // aggression = more harmonic energy up top, not just "brighter"
    targetRatio: 1.6,
    controls: [
      { id: "fx.drive", dir: +1, step: 0.14 },
      { id: "filter.reso", dir: +1, step: 0.08 },
      { id: "filter.cutoff", dir: +1, step: 0.05 },
    ],
    constraints: [{ metric: "rms", maxRatio: 3.0 }], // don't let it get uncontrollably loud
  },
  softer: {
    id: "softer",
    description: "Back off drive and resonance for a gentler, smoother tone (lowers high-band energy).",
    metric: "highRatio",
    targetRatio: 0.65,
    controls: [
      { id: "fx.drive", dir: -1, step: 0.14 },
      { id: "filter.reso", dir: -1, step: 0.08 },
    ],
  },
  wider: {
    id: "wider",
    description:
      "Increase unison detune for a wider, thicker tone (raises stereo width). Closed-loop: " +
      "converges on the side/mid energy ratio. On a mono render there is no width to move, so " +
      "it early-exits with reason 'mono-render-no-stereo-metric'.",
    metric: "stereoWidth",
    targetRatio: 1.3,
    minDelta: 0.05, // width is 0..1 and can start near zero; require real absolute movement
    controls: [{ id: "osc.detune", dir: +1, step: 0.25 }],
  },
  movement: {
    id: "movement",
    description:
      "Speed up LFO 1 for more motion/animation (raises spectral flux — change over time).",
    metric: "flux",
    targetRatio: 1.4,
    controls: [{ id: "lfo1.rate", dir: +1, step: 0.3 }],
  },
  explore: {
    id: "explore",
    description:
      "Seeded randomized exploration — \"surprise me\": jitters several controls at once " +
      "for a variation on the current sound. Run with a random proposer (proposers.ts) and " +
      "record the seed for reproducibility. Open-loop: reports param deltas; fully revertable. " +
      "With the random proposer, each control's `step` is the jitter magnitude (dir is ignored).",
    controls: [
      { id: "filter.cutoff", dir: +1, step: 0.18 },
      { id: "filter.reso", dir: +1, step: 0.15 },
      { id: "fx.drive", dir: +1, step: 0.18 },
      { id: "sub.level", dir: +1, step: 0.22 },
      { id: "osc.detune", dir: +1, step: 0.18 },
      { id: "lfo1.rate", dir: +1, step: 0.22 },
    ],
  },
};

// Tiny intent router: natural-language phrase -> recipe. Kept as the no-LLM fallback and as
// a test fixture; the real planner is Claude choosing a recipe id via MCP tool descriptions.
// ORDER MATTERS: negated/decreasing phrasings ("less bright", "less aggressive") must be
// routed before the positive patterns that their words would otherwise match.
export function matchIntent(text: string): Recipe | null {
  const t = (text || "").toLowerCase();

  // decreasing/negated intents first
  if (/less\s+aggress|soft|gentl|smooth|tame|mellow|calm/.test(t)) return RECIPES.softer!;
  if (/less\s+bright|dark|dull|warm|muffle|less\s+(open|air)/.test(t)) return RECIPES.darker!;
  if (/less\s+(bass|low|sub)|too\s+(boomy|muddy)|thin(ner)?\s+(it\s+)?out|cut\s+the\s+(bass|low)/.test(t)) {
    return RECIPES.lessBass!;
  }

  // increasing intents
  if (/aggress|harder|dirt|grit|nast|distort|mean/.test(t)) return RECIPES.aggressive!;
  if (/bass|low\s*end|sub|fat(ter)?|fuller|beef|bottom/.test(t)) return RECIPES.moreBass!;
  if (/bright|open|air|crisp|shin/.test(t)) return RECIPES.brighter!;
  if (/wide|stereo|spread|thick|big(ger)?/.test(t)) return RECIPES.wider!;
  if (/move|motion|animat|wobble|evolv|alive|lfo/.test(t)) return RECIPES.movement!;
  if (/surprise|random|explore|experiment|something\s+(new|different)|inspir/.test(t)) {
    return RECIPES.explore!;
  }

  return null;
}
