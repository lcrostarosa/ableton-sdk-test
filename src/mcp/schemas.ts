// Zod input schemas for the MCP tools. The recipe and synth enums are generated from the
// portable engine's RECIPES/PROFILES so the tool surface can never drift from what
// actually runs.

import { z } from "zod";
import { RECIPES } from "../common/recipes.ts";
import { PROFILES, DEFAULT_PROFILE } from "../common/profiles.ts";

export const recipeIds = Object.keys(RECIPES) as [string, ...string[]];
export const synthIds = Object.keys(PROFILES) as [string, ...string[]];

export const trackRefShape = {
  trackIndex: z.number().int().min(0).optional()
    .describe("Track index in the Live Set (0-based). Omit both refs to auto-find the synth's track."),
  trackName: z.string().optional()
    .describe("Case-insensitive substring of the track name (used when trackIndex is omitted)."),
};

export const regionShape = {
  startBeat: z.number().optional()
    .describe("Start of the measured arrangement region in beats (default: the synth profile's region)."),
  endBeat: z.number().optional()
    .describe("End of the measured arrangement region in beats (default: the synth profile's region)."),
};

export const synthShape = {
  synth: z.enum(synthIds).optional()
    .describe(`Synth profile id (default "${DEFAULT_PROFILE.id}"). Profiles carry the device matcher, control registry, safe ranges, and measurement defaults.`),
  deviceMatch: z.string().optional()
    .describe("Case-insensitive substring of the device name; overrides the profile's matcher."),
};

export const getDeviceShape = {
  ...trackRefShape,
  ...synthShape,
  maxParams: z.number().int().min(1).max(256).optional()
    .describe("Cap on listed parameters (default 64; output reports `truncated`)."),
  includeValues: z.boolean().optional()
    .describe("Also read each parameter's current value (slower on large devices)."),
};

export const applyIntentShape = {
  ...trackRefShape,
  ...regionShape,
  ...synthShape,
  recipeId: z.enum(recipeIds)
    .describe("Which sound-shaping recipe to run. See the tool description for the catalog."),
  intensity: z.number().min(0).max(1).optional()
    .describe("Step-size scale 0..1 (default 1). Use ~0.3 for a subtle move, 1 for a decisive one."),
  maxIters: z.number().int().min(1).max(10).optional()
    .describe("Convergence iteration cap (default 5)."),
  seed: z.number().int().optional()
    .describe(
      "PRNG seed for the non-deterministic path. \"explore\" seeds itself when omitted; " +
      "pass the seed from a previous result to replay it exactly. Any recipe given a seed " +
      "runs the seeded random proposer instead of its deterministic stepper."
    ),
};

export const revertShape = {
  token: z.string().optional()
    .describe("revertToken from an apply result. Omit to revert the most recent intent."),
};

export const runCodeShape = {
  code: z.string()
    .describe(
      "Async JavaScript body executed inside Live's extension host with (song, resources, fs) " +
      "in scope. `return` a JSON-serializable value."
    ),
};
