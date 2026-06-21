// The generic convergence engine — N controls, any metric, any synth, any proposer.
// The mechanics that make the loop safe live HERE, around whatever proposes the next move:
// clamp to each control's safe range, invariant guards (constraints can veto a step),
// hard iteration cap, snapshot for whole-edit undo. BIDIRECTIONAL targets (targetRatio < 1
// drives the metric DOWN — darker/lessBass/softer), an intensity scale on step sizes, and
// open-loop recipes (no metric: apply the controls, report the parameter deltas).
//
// The PROPOSER is the decision seam: a function from loop state to the next proposed
// control values (or null to stop). The default is the deterministic recipe stepper
// (damped fixed steps — the original behavior). Seeded random walks (proposers.ts) and
// LLM planners are drop-in alternatives; they all run inside the same safety harness.
//
// Adapter contract (generic): get(id) / set(id, v) normalized 0..1, measure() -> APO, and
// safeOf(id) from the adapter's synth profile. Any sync or async adapter can implement it,
// so the same engine runs unchanged against different backends.

import type { Range } from "./registry.ts";
import { STEREO_METRICS } from "./measure.ts";
import type { ScalarAPO, Metric } from "./measure.ts";
import type { Constraint, Control, Recipe } from "./recipes.ts";

// A value the adapter may return synchronously or as a Promise.
export type Awaitable<T> = T | Promise<T>;

// The generic, multi-knob adapter contract. Values may be sync or async; `applyRecipe`
// awaits every call.
export interface RecipeAdapter {
  get(id: string): Awaitable<number>;
  set(id: string, n: number): Awaitable<void>;
  measure(): Awaitable<ScalarAPO>;
  /** Safe operating range for a control id, from the adapter's synth profile. */
  safeOf(id: string): Range;
}

// ---- the proposal seam ----

// What a proposer sees each iteration. `beforeAPO`/`lastAPO` are null for open-loop
// recipes (nothing is measured); `safe` carries every control's clamp range so proposers
// can sample inside it instead of being clipped at the edges.
export interface ProposerState {
  iter: number;
  controls: Control[];
  current: Record<string, number>;
  safe: Record<string, Range>;
  intensity: number;
  beforeAPO: ScalarAPO | null;
  lastAPO: ScalarAPO | null;
  log: RecipeLogEntry[];
}

/** Next proposed values per control id (missing ids = leave unchanged), or null to stop. */
export type Proposer = (state: ProposerState) => Awaitable<Record<string, number> | null>;

// The default proposer: the recipe's own deterministic stepping — push each control
// dir * step * intensity per iteration, halving the steps whenever the last measured move
// failed to push the metric the right way (damping; prevents oscillation).
export function makeRecipeStepper(recipe: Recipe): Proposer {
  let steps: number[] | null = null;
  let prev: number | null = null;
  const rising = (recipe.targetRatio ?? 1) >= 1;
  return (state) => {
    steps ??= state.controls.map((c) => c.step * state.intensity);
    if (recipe.metric != null && state.lastAPO != null) {
      const m = state.lastAPO[recipe.metric];
      if (prev != null && (rising ? m <= prev : m >= prev)) steps = steps.map((s) => s * 0.5);
      prev = m;
    }
    return Object.fromEntries(
      state.controls.map((c, idx) => [c.id, state.current[c.id]! + c.dir * steps![idx]!])
    );
  };
}

export interface ApplyRecipeOptions {
  maxIters?: number;
  /** Step-size scale 0..1 (clamped). Overrides the recipe's own `intensity`; default 1. */
  intensity?: number;
  /** Decision seam: proposes the next control values. Default: the recipe's own stepper. */
  proposer?: Proposer;
}

export interface RecipeLogEntry {
  iter: number;
  metric: number;
  controls: Record<string, number>;
}

// Per-control before/after — the "param-delta success report" (the only success evidence
// an open-loop recipe has; useful reporting for closed-loop ones too).
export interface ControlDelta {
  before: number;
  after: number;
}

export interface RecipeResult {
  recipe: string;
  /** null for open-loop recipes (no APO metric to target). */
  metric: Metric | null;
  before: number | null;
  after: number | null;
  ratio: number | null;
  reason: string;
  snapshot: Record<string, number>;
  deltas: Record<string, ControlDelta>;
  /** null for open-loop recipes (nothing was measured). */
  beforeAPO: ScalarAPO | null;
  afterAPO: ScalarAPO | null;
  log: RecipeLogEntry[];
  revert: () => Promise<void>;
}

export function clamp(x: number, [lo, hi]: Range): number {
  return Math.min(hi, Math.max(lo, x));
}

function violated(constraints: Constraint[], apo: ScalarAPO, before: ScalarAPO): Constraint | undefined {
  return constraints.find(
    (k) =>
      (k.maxRatio != null && apo[k.metric] > before[k.metric] * k.maxRatio) ||
      (k.minRatio != null && apo[k.metric] < before[k.metric] * k.minRatio)
  );
}

export async function applyRecipe(
  adapter: RecipeAdapter,
  recipe: Recipe,
  opts: ApplyRecipeOptions = {}
): Promise<RecipeResult> {
  const intensity = clamp(opts.intensity ?? recipe.intensity ?? 1, [0.05, 1]);
  const proposer = opts.proposer ?? makeRecipeStepper(recipe);

  const controls = recipe.controls;
  const safe: Record<string, Range> = Object.fromEntries(
    controls.map((c) => [c.id, adapter.safeOf(c.id)])
  );

  // snapshot every control we might touch, for whole-edit undo
  const snapshot: Record<string, number> = {};
  for (const c of controls) snapshot[c.id] = await adapter.get(c.id);
  const revert = async () => {
    for (const id of Object.keys(snapshot)) await adapter.set(id, snapshot[id]!);
  };
  const deltasFrom = (cur: Record<string, number>): Record<string, ControlDelta> =>
    Object.fromEntries(controls.map((c) => [c.id, { before: snapshot[c.id]!, after: cur[c.id]! }]));

  // Clamp a proposal into every control's safe range; report whether anything moved.
  const clampProposal = (
    cur: Record<string, number>,
    proposal: Record<string, number>
  ): { proposed: Record<string, number>; anyMoved: boolean } => {
    const proposed: Record<string, number> = { ...cur };
    let anyMoved = false;
    for (const c of controls) {
      if (proposal[c.id] == null) continue;
      const next = clamp(proposal[c.id]!, safe[c.id]!);
      if (next !== cur[c.id]) anyMoved = true;
      proposed[c.id] = next;
    }
    return { proposed, anyMoved };
  };

  // ---- open-loop: no metric to converge on; apply one proposal and report deltas ----
  if (recipe.metric == null || recipe.targetRatio == null) {
    const cur: Record<string, number> = { ...snapshot };
    const proposal = await proposer({
      iter: 1, controls, current: { ...cur }, safe, intensity,
      beforeAPO: null, lastAPO: null, log: [],
    });
    const { proposed, anyMoved } = clampProposal(cur, proposal ?? {});
    for (const c of controls) await adapter.set(c.id, proposed[c.id]!);
    return {
      recipe: recipe.id,
      metric: null,
      before: null,
      after: null,
      ratio: null,
      reason: proposal == null ? "proposer-stop" : anyMoved ? "applied-open-loop" : "hit-safe-limit",
      snapshot,
      deltas: deltasFrom(proposed),
      beforeAPO: null,
      afterAPO: null,
      log: [{ iter: 0, metric: NaN, controls: { ...proposed } }],
      revert,
    };
  }

  // ---- closed-loop: converge the metric onto before * targetRatio ----
  const maxIters = opts.maxIters != null ? opts.maxIters : 5;
  const constraints = recipe.constraints || [];
  const rising = recipe.targetRatio >= 1; // < 1 drives the metric DOWN (darker/lessBass)

  const before = await adapter.measure();

  // Mono-render guard: a recipe targeting a stereo-only metric (stereoWidth/correlation/
  // corrBelow120) cannot converge on a mono render — the metric sits at its mono default and
  // would never move. Early-exit with an actionable reason instead of spinning to max-iters.
  if (STEREO_METRICS.has(recipe.metric) && before.stereoWidth === 0 && before.correlation === 1) {
    return {
      recipe: recipe.id,
      metric: recipe.metric,
      before: before[recipe.metric],
      after: before[recipe.metric],
      ratio: 1,
      reason: "mono-render-no-stereo-metric",
      snapshot,
      deltas: deltasFrom(snapshot),
      beforeAPO: before,
      afterAPO: before,
      log: [{ iter: 0, metric: before[recipe.metric], controls: { ...snapshot } }],
      revert,
    };
  }

  // Convergence target with an additive floor (minDelta): for metrics that can legitimately
  // sit near zero (stereoWidth/flux), `before * targetRatio ≈ 0` would make the target
  // instantly "met" or unmovable, so require at least an absolute `minDelta` of movement.
  const minDelta = recipe.minDelta ?? 0;
  const target =
    rising
      ? Math.max(before[recipe.metric] * recipe.targetRatio, before[recipe.metric] + minDelta)
      : Math.min(before[recipe.metric] * recipe.targetRatio, before[recipe.metric] - minDelta);

  let cur: Record<string, number> = { ...snapshot };
  let lastAPO = before;
  let reason = "max-iters";

  const log: RecipeLogEntry[] = [{ iter: 0, metric: before[recipe.metric], controls: { ...cur } }];

  for (let i = 1; i <= maxIters; i++) {
    const proposal = await proposer({
      iter: i, controls, current: { ...cur }, safe, intensity,
      beforeAPO: before, lastAPO, log,
    });
    if (proposal == null) { reason = "proposer-stop"; break; }

    const { proposed, anyMoved } = clampProposal(cur, proposal);
    if (!anyMoved) { reason = "hit-safe-limit"; break; }

    for (const c of controls) await adapter.set(c.id, proposed[c.id]!);
    const apo = await adapter.measure();

    // invariant guard: if any constraint is violated, revert this step and stop
    const broke = violated(constraints, apo, before);
    if (broke) {
      for (const c of controls) await adapter.set(c.id, cur[c.id]!);
      reason = `constraint-blocked:${broke.metric}`;
      break;
    }

    cur = proposed;
    lastAPO = apo;
    const m = apo[recipe.metric];
    log.push({ iter: i, metric: m, controls: { ...cur } });

    if (rising ? m >= target : m <= target) { reason = "target-met"; break; }
  }

  const after = await adapter.measure();
  return {
    recipe: recipe.id,
    metric: recipe.metric,
    before: before[recipe.metric],
    after: after[recipe.metric],
    ratio: after[recipe.metric] / (before[recipe.metric] || 1),
    reason,
    snapshot,
    deltas: deltasFrom(cur),
    beforeAPO: before,
    afterAPO: after,
    log,
    revert,
  };
}
