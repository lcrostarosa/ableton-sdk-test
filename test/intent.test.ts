// Generalized engine: registry + recipes + multi-knob convergence. Pure Node, no rig.
//   node ideas/demo/intent.test.ts
import assert from "node:assert";
import { SimAdapter } from "./fixtures/adapters/simAdapter.ts";
import { applyRecipe } from "../src/intentEngine.ts";
import { makeRandomProposer } from "../src/proposers.ts";
import { RECIPES, matchIntent } from "../src/recipes.ts";
import { SERUM_PROFILE } from "../src/profiles.ts";
import {
  byId as byIdOf,
  checkExposure as checkExposureOf,
  resolveAlias as resolveAliasOf,
  safeOf as safeRangeOf,
} from "../src/registry.ts";

// Registry helpers are profile-parametric now; these tests exercise the Serum profile.
const byId = (id: string) => byIdOf(SERUM_PROFILE, id);
const resolveAlias = (name: string) => resolveAliasOf(SERUM_PROFILE, name);
const checkExposure = (names: string[]) =>
  checkExposureOf(SERUM_PROFILE, names);
const safeOf = (id: string) => safeRangeOf(SERUM_PROFILE, id);

let pass = 0;
function check(name: string, fn: () => unknown): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("  ✓ " + name);
      pass++;
    })
    .catch((e: unknown) => {
      console.log(
        "  ✗ " + name + " - " + (e instanceof Error ? e.message : String(e)),
      );
      process.exitCode = 1;
    });
}

function freshAdapter(): SimAdapter {
  const a = new SimAdapter();
  a.set("filter.cutoff", 0.45);
  a.set("fx.drive", 0.0);
  a.set("filter.reso", 0.1);
  return a;
}

console.log("registry:");
await check(
  'resolves "cutoff" alias and Serum-style names to filter.cutoff',
  () => {
    assert.strictEqual(resolveAlias("cutoff")?.id, "filter.cutoff");
    assert.strictEqual(resolveAlias("A Cutoff")?.id, "filter.cutoff");
    assert.strictEqual(resolveAlias("grit")?.id, "fx.drive");
  },
);

await check(
  "resolves the new Phase-1 controls (sub level, detune, LFO rate)",
  () => {
    assert.strictEqual(resolveAlias("Sub Level")?.id, "sub.level");
    assert.strictEqual(resolveAlias("Sub Osc Volume")?.id, "sub.level");
    assert.strictEqual(resolveAlias("A Unison Detune")?.id, "osc.detune");
    assert.strictEqual(resolveAlias("Detune")?.id, "osc.detune");
    assert.strictEqual(resolveAlias("LFO 1 Rate")?.id, "lfo1.rate");
    assert.strictEqual(resolveAlias("LFO1 Rate")?.id, "lfo1.rate");
  },
);

await check("checkExposure partitions exposed vs missing param names", () => {
  const r = checkExposure(["A Cutoff", "Drive", "Sub Level"]);
  assert.deepStrictEqual(r.found.map((f) => f.id).sort(), [
    "filter.cutoff",
    "fx.drive",
    "sub.level",
  ]);
  assert.deepStrictEqual(r.missing.map((m) => m.id).sort(), [
    "filter.reso",
    "lfo1.rate",
    "osc.detune",
  ]);
  assert.strictEqual(
    r.found.find((f) => f.id === "sub.level")?.paramName,
    "Sub Level",
  );
});

await check("every recipe's control ids resolve in the registry", () => {
  for (const recipe of Object.values(RECIPES)) {
    for (const c of recipe.controls)
      assert.ok(byId(c.id), `${recipe.id}: ${c.id}`);
  }
});

console.log("intent routing (all 8, incl. negatives):");
await check("each of the 8 recipes is reachable from natural phrasings", () => {
  const phrases: [string, string][] = [
    ["make this synth brighter", "brighter"],
    ["more air please", "brighter"],
    ["crisper", "brighter"],
    ["make it darker", "darker"],
    ["less bright", "darker"], // negative: must NOT hit brighter
    ["warmer and duller", "darker"],
    ["add more bass", "moreBass"],
    ["fatter low end", "moreBass"],
    ["beef up the bottom", "moreBass"],
    ["less bass", "lessBass"], // negative: must NOT hit moreBass
    ["it's too boomy", "lessBass"],
    ["cut the low end a bit", "lessBass"],
    ["make the bass more aggressive", "aggressive"],
    ["harder and dirtier", "aggressive"],
    ["nastier, distorted", "aggressive"],
    ["softer please", "softer"],
    ["less aggressive", "softer"], // negative: must NOT hit aggressive
    ["smoother and mellower", "softer"],
    ["make it wider", "wider"],
    ["more stereo spread", "wider"],
    ["more movement", "movement"],
    ["make it wobble and evolve", "movement"],
    ["surprise me", "explore"],
    ["try something different", "explore"],
  ];
  for (const [phrase, want] of phrases) {
    assert.strictEqual(
      matchIntent(phrase)?.id,
      want,
      `"${phrase}" -> ${matchIntent(phrase)?.id}`,
    );
  }
  assert.strictEqual(
    matchIntent("transpose it up a fifth"),
    null,
    "unrelated phrase matched",
  );
});

console.log("generalized engine (multi-knob):");

await check(
  "aggressive raises high-frequency energy via drive+reso+cutoff",
  async () => {
    const a = freshAdapter();
    const r = await applyRecipe(a, RECIPES.aggressive!);
    assert(
      r.after! > r.before!,
      `highRatio did not rise (${r.before} -> ${r.after})`,
    );
    // proves it actually moved more than one knob
    assert(
      a.get("fx.drive") > 0 && a.get("filter.reso") > 0.1,
      "drive/reso were not engaged",
    );
  },
);

await check("loop is bounded (no runaway)", async () => {
  const a = freshAdapter();
  const r = await applyRecipe(a, { ...RECIPES.aggressive!, targetRatio: 999 });
  assert(r.log.length <= 6, `ran ${r.log.length} iterations (> maxIters+1)`);
});

await check("every control stays within its registry safe range", async () => {
  const a = freshAdapter();
  await applyRecipe(a, { ...RECIPES.aggressive!, targetRatio: 999 });
  for (const id of ["fx.drive", "filter.reso", "filter.cutoff"]) {
    const [lo, hi] = safeOf(id);
    const v = a.get(id);
    assert(
      v >= lo - 1e-9 && v <= hi + 1e-9,
      `${id}=${v} outside [${lo},${hi}]`,
    );
  }
});

await check(
  "invariant guard vetoes a step that breaks the maxRatio constraint",
  async () => {
    const a = freshAdapter();
    // a punishing loudness cap the aggressive drive will trip
    const guarded = {
      ...RECIPES.aggressive!,
      targetRatio: 999,
      constraints: [{ metric: "rms" as const, maxRatio: 1.05 }],
    };
    const r = await applyRecipe(a, guarded);
    assert(
      /constraint-blocked:rms/.test(r.reason),
      `expected constraint block, got ${r.reason}`,
    );
    assert(
      r.afterAPO!.rms <= r.beforeAPO!.rms * 1.05 + 1e-6,
      "rms exceeded the invariant after revert",
    );
  },
);

await check(
  "minRatio constraint vetoes a step that collapses a metric",
  async () => {
    const a = freshAdapter();
    a.set("sub.level", 0.6); // give the low end something to lose
    // lessBass pulls the sub down; a tight bassRatio floor ("keep the low end present")
    // must veto the very first step and leave the patch inside the invariant
    const guarded = {
      ...RECIPES.lessBass!,
      targetRatio: 0.01,
      constraints: [{ metric: "bassRatio" as const, minRatio: 0.99 }],
    };
    const r = await applyRecipe(a, guarded);
    assert(
      /constraint-blocked:bassRatio/.test(r.reason),
      `expected constraint block, got ${r.reason}`,
    );
    assert(
      r.afterAPO!.bassRatio >= r.beforeAPO!.bassRatio * 0.99 - 1e-6,
      "bassRatio fell below the floor after revert",
    );
  },
);

console.log("bidirectional engine:");

await check(
  "darker converges DOWN (targetRatio < 1 lowers the centroid)",
  async () => {
    const a = freshAdapter();
    const r = await applyRecipe(a, RECIPES.darker!);
    assert(
      r.metric === "centroid" && r.after! < r.before!,
      `centroid did not fall (${r.before} -> ${r.after})`,
    );
  },
);

await check("moreBass raises bassRatio; lessBass lowers it back", async () => {
  const a = freshAdapter();
  const up = await applyRecipe(a, RECIPES.moreBass!);
  assert(
    up.after! > up.before!,
    `bassRatio did not rise (${up.before} -> ${up.after})`,
  );
  const down = await applyRecipe(a, RECIPES.lessBass!);
  assert(
    down.after! < down.before!,
    `bassRatio did not fall (${down.before} -> ${down.after})`,
  );
});

await check("softer lowers highRatio from an aggressive patch", async () => {
  const a = freshAdapter();
  a.set("fx.drive", 0.6);
  a.set("filter.reso", 0.4);
  const r = await applyRecipe(a, RECIPES.softer!);
  assert(
    r.after! < r.before!,
    `highRatio did not fall (${r.before} -> ${r.after})`,
  );
});

await check("brighter runs through the SAME generic engine", async () => {
  const a = freshAdapter();
  const r = await applyRecipe(a, RECIPES.brighter!);
  assert(
    r.metric === "centroid" && r.after! > r.before!,
    "brightness did not rise",
  );
});

console.log("intensity:");

await check(
  "intensity scales the step (0.3 moves the knob less than 1.0)",
  async () => {
    const gentle = freshAdapter();
    await applyRecipe(
      gentle,
      { ...RECIPES.brighter!, targetRatio: 999 },
      { maxIters: 2, intensity: 0.3 },
    );
    const full = freshAdapter();
    await applyRecipe(
      full,
      { ...RECIPES.brighter!, targetRatio: 999 },
      { maxIters: 2, intensity: 1 },
    );
    const g = gentle.get("filter.cutoff"),
      f = full.get("filter.cutoff");
    assert(g > 0.45 && g < f, `intensity not scaling: gentle=${g} full=${f}`);
  },
);

await check(
  "out-of-range intensity clamps instead of exploding or freezing",
  async () => {
    const a = freshAdapter();
    await applyRecipe(
      a,
      { ...RECIPES.brighter!, targetRatio: 999 },
      { maxIters: 1, intensity: 50 },
    );
    assert(
      Math.abs(a.get("filter.cutoff") - (0.45 + 0.08)) < 1e-9,
      "intensity>1 must clamp to 1",
    );
    const b = freshAdapter();
    await applyRecipe(
      b,
      { ...RECIPES.brighter!, targetRatio: 999 },
      { maxIters: 1, intensity: -3 },
    );
    assert(
      b.get("filter.cutoff") > 0.45,
      "intensity<=0 must clamp to a small positive step",
    );
  },
);

console.log("graduated closed-loop recipes (wider / movement):");

await check(
  "wider on a MONO render early-exits (mono-render-no-stereo-metric)",
  async () => {
    // SimAdapter renders FakeSerum mono, so stereoWidth sits at its mono default (0) and
    // can never converge. The engine must early-exit with an actionable reason rather than
    // spin to max-iters, and must NOT move any control.
    const a = freshAdapter();
    const before = a.get("osc.detune");
    const r = await applyRecipe(a, RECIPES.wider!);
    assert.strictEqual(r.metric, "stereoWidth");
    assert.strictEqual(r.reason, "mono-render-no-stereo-metric");
    assert.strictEqual(r.before, r.after, "metric should be unchanged on early exit");
    assert(
      Math.abs(a.get("osc.detune") - before) < 1e-9,
      "mono early-exit must not move detune",
    );
  },
);

await check("movement drives the flux metric closed-loop, knob stays in range", async () => {
  const a = freshAdapter();
  const r = await applyRecipe(a, RECIPES.movement!);
  const [lo, hi] = safeOf("lfo1.rate");
  const v = a.get("lfo1.rate");
  assert.strictEqual(r.metric, "flux");
  assert(
    r.deltas["lfo1.rate"]!.after > r.deltas["lfo1.rate"]!.before,
    "lfo rate did not move",
  );
  assert(
    v >= lo - 1e-9 && v <= hi + 1e-9,
    `lfo1.rate=${v} outside [${lo},${hi}]`,
  );
});

await check(
  "open-loop at the safe limit reports hit-safe-limit, not success",
  async () => {
    // An inline open-loop recipe (no metric) whose only control already sits at its safe top:
    // the directed proposal clamps to a no-op, so the engine reports hit-safe-limit.
    const a = freshAdapter();
    a.set("osc.detune", safeOf("osc.detune")[1]); // already at the top
    const openLoop = {
      id: "nudge-detune",
      description: "open-loop detune nudge (test fixture)",
      controls: [{ id: "osc.detune", dir: 1 as const, step: 0.25 }],
    };
    const r = await applyRecipe(a, openLoop);
    assert.strictEqual(r.metric, null);
    assert.strictEqual(r.reason, "hit-safe-limit");
  },
);

console.log("revert:");

await check("revert restores every touched control", async () => {
  const a = freshAdapter();
  const before = {
    d: a.get("fx.drive"),
    r: a.get("filter.reso"),
    c: a.get("filter.cutoff"),
  };
  const res = await applyRecipe(a, RECIPES.aggressive!);
  await res.revert();
  assert(Math.abs(a.get("fx.drive") - before.d) < 1e-9, "drive not restored");
  assert(Math.abs(a.get("filter.reso") - before.r) < 1e-9, "reso not restored");
  assert(
    Math.abs(a.get("filter.cutoff") - before.c) < 1e-9,
    "cutoff not restored",
  );
});

await check(
  "revert restores the new controls too (sub level, detune)",
  async () => {
    const a = freshAdapter();
    a.set("sub.level", 0.2);
    a.set("osc.detune", 0.1);
    const r1 = await applyRecipe(a, RECIPES.moreBass!);
    await r1.revert();
    assert(Math.abs(a.get("sub.level") - 0.2) < 1e-9, "sub.level not restored");
    const r2 = await applyRecipe(a, RECIPES.wider!);
    await r2.revert();
    assert(
      Math.abs(a.get("osc.detune") - 0.1) < 1e-9,
      "osc.detune not restored",
    );
  },
);

console.log("proposer seam (non-deterministic workflows):");

await check(
  "explore with a seeded random proposer is reproducible across runs",
  async () => {
    const run = async (seed: number) => {
      const a = freshAdapter();
      return applyRecipe(a, RECIPES.explore!, {
        proposer: makeRandomProposer({ seed }),
      });
    };
    const afters = (r: Awaited<ReturnType<typeof run>>) =>
      Object.fromEntries(
        Object.entries(r.deltas).map(([k, d]) => [k, d.after]),
      );
    const r1 = await run(42),
      r2 = await run(42),
      r3 = await run(7);
    assert.deepStrictEqual(
      afters(r1),
      afters(r2),
      "same seed must replay the same deltas",
    );
    assert.notDeepStrictEqual(
      afters(r1),
      afters(r3),
      "different seeds should explore differently",
    );
    assert.strictEqual(r1.reason, "applied-open-loop");
  },
);

await check(
  "random proposals are clamped into every safe range (walk and jump)",
  async () => {
    for (const mode of ["walk", "jump"] as const) {
      const a = freshAdapter();
      await applyRecipe(a, RECIPES.explore!, {
        proposer: makeRandomProposer({ seed: 1234, mode }),
        intensity: 1,
      });
      for (const c of RECIPES.explore!.controls) {
        const [lo, hi] = safeOf(c.id);
        const v = a.get(c.id);
        assert(
          v >= lo - 1e-9 && v <= hi + 1e-9,
          `${mode}: ${c.id}=${v} outside [${lo},${hi}]`,
        );
      }
    }
  },
);

await check(
  "a random proposer can drive a CLOSED loop (still bounded + clamped)",
  async () => {
    const a = freshAdapter();
    const r = await applyRecipe(a, RECIPES.aggressive!, {
      proposer: makeRandomProposer({ seed: 99 }),
      maxIters: 4,
    });
    assert(r.log.length <= 5, `ran ${r.log.length} iterations (> maxIters+1)`);
    for (const c of RECIPES.aggressive!.controls) {
      const [lo, hi] = safeOf(c.id);
      const v = a.get(c.id);
      assert(
        v >= lo - 1e-9 && v <= hi + 1e-9,
        `${c.id}=${v} outside [${lo},${hi}]`,
      );
    }
  },
);

await check(
  "a proposer returning null stops the loop with proposer-stop",
  async () => {
    const a = freshAdapter();
    const r = await applyRecipe(a, RECIPES.brighter!, { proposer: () => null });
    assert.strictEqual(r.reason, "proposer-stop");
    assert(
      Math.abs(a.get("filter.cutoff") - 0.45) < 1e-9,
      "nothing should have moved",
    );
  },
);

await check("explore is revertable like any other edit", async () => {
  const a = freshAdapter();
  const before = Object.fromEntries(
    RECIPES.explore!.controls.map((c) => [c.id, a.get(c.id)]),
  );
  const r = await applyRecipe(a, RECIPES.explore!, {
    proposer: makeRandomProposer({ seed: 5 }),
  });
  await r.revert();
  for (const c of RECIPES.explore!.controls) {
    assert(
      Math.abs(a.get(c.id) - before[c.id]!) < 1e-9,
      `${c.id} not restored`,
    );
  }
});

console.log(`\n${pass} checks passed`);
