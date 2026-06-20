// Structural checks on the in-Live sound-intent surface (no host needed): the menu
// commands must reference real recipes and stay collision-free. The engine behavior
// behind them is covered by ../../intent.test.ts and ../../liveAdapter.test.ts.
//   npx tsx src/soundIntents.test.ts
import assert from "node:assert";
import { INTENT_COMMANDS, REVERT_COMMAND_ID } from "./soundIntents.ts";
import { RECIPES } from "../../src/recipes.ts";

let pass = 0;
function check(name: string, fn: () => unknown): void {
  try {
    fn();
    console.log("  ✓ " + name);
    pass++;
  } catch (e) {
    console.log("  ✗ " + name + " - " + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}

console.log("sound-intent menu surface:");

check("every menu command references an existing recipe", () => {
  for (const c of INTENT_COMMANDS) {
    assert.ok(RECIPES[c.recipeId], `${c.commandId} -> unknown recipe "${c.recipeId}"`);
  }
});

check("the plan's minimum surface is present (brighter, moreBass, aggressive)", () => {
  const ids = INTENT_COMMANDS.map((c) => c.recipeId);
  for (const want of ["brighter", "moreBass", "aggressive"]) {
    assert.ok(ids.includes(want), `missing canned intent ${want}`);
  }
});

check("the seeded exploration surface is present (Surprise Me -> explore)", () => {
  const surprise = INTENT_COMMANDS.find((c) => c.recipeId === "explore");
  assert.ok(surprise, "missing the explore intent");
  assert.match(surprise.label, /surprise/i);
});

check("command ids are unique (incl. revert)", () => {
  const ids = [...INTENT_COMMANDS.map((c) => c.commandId), REVERT_COMMAND_ID];
  assert.strictEqual(new Set(ids).size, ids.length, `duplicates in ${ids}`);
});

check("menu labels are distinct and human-readable", () => {
  const labels = INTENT_COMMANDS.map((c) => c.label);
  assert.strictEqual(new Set(labels).size, labels.length);
  for (const l of labels) assert.ok(/^Sound: /.test(l), `label "${l}" missing the Sound: prefix`);
});

console.log(`\n${pass} checks passed`);
