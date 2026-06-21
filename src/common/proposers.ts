// Non-deterministic proposers — alternative "brains" for applyRecipe's loop. The engine
// keeps every safety property (safe-range clamps, constraint guards, snapshot/revert,
// iteration cap) no matter what proposes the moves; these just propose differently.
//
// All randomness is SEEDED: the same seed replays the same proposal sequence, so an
// exploration result can be reported, reproduced, and reverted like any other edit.

import type { Proposer } from "./intentEngine.ts";

/** mulberry32 — a tiny, fast, seedable PRNG (uniform in [0, 1)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomProposerOptions {
  /** PRNG seed — record it with the result so the exploration is reproducible. */
  seed: number;
  /**
   * "walk" (default): jitter each control around its current value by up to
   * ±step·intensity — a variation that respects the existing sound.
   * "jump": sample each control uniformly inside its safe range — a fresh patch.
   */
  mode?: "walk" | "jump";
}

export function makeRandomProposer({ seed, mode = "walk" }: RandomProposerOptions): Proposer {
  const rng = mulberry32(seed);
  return (state) => {
    const out: Record<string, number> = {};
    for (const c of state.controls) {
      if (mode === "jump") {
        const [lo, hi] = state.safe[c.id]!;
        out[c.id] = lo + rng() * (hi - lo);
      } else {
        out[c.id] = state.current[c.id]! + (rng() * 2 - 1) * c.step * state.intensity;
      }
    }
    return out;
  };
}
