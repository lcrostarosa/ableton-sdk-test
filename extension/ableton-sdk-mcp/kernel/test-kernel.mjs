// Offline kernel handler tests — the REAL handlers (resolveTrack, adapterFor, the apply →
// revert lifecycle) against a fake Live rig (FakeSerum render behind fake SDK objects).
// Complements abletonsdk-mcp-server/test-mcp.mjs, which stubs at the bridge instead.
//   node test-kernel.mjs
import assert from "node:assert";
import { cleanupFakeKernelRig, makeRig } from "../../../test/fixtures/mcp/fakeKernelRig.mjs";

let pass = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ✓ " + name);
    pass++;
  } catch (e) {
    console.log("  ✗ " + name + " - " + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}

console.log("kernel handlers against a fake rig:");

await check("get_context summarizes tracks and devices", async () => {
  const { handlers } = makeRig();
  const ctx = await handlers.get_context();
  assert.strictEqual(ctx.tracks.length, 3);
  assert.deepStrictEqual(ctx.tracks[1], { index: 1, name: "Serum Bass", type: "Track", devices: ["Serum2"] });
});

await check("apply_sound_intent auto-finds the Serum track and converges brighter", async () => {
  const { handlers, params } = makeRig();
  const r = await handlers.apply_sound_intent({ recipeId: "brighter" });
  assert.strictEqual(r.recipe, "brighter");
  assert.ok(r.after > r.before, `centroid did not rise (${r.before} -> ${r.after})`);
  assert.ok(r.revertToken, "no revert token");
  assert.ok((await params.cutoff.getValue()) > 0.45, "cutoff did not move");
});

await check("revert_sound_intent restores the snapshot by token", async () => {
  const { handlers, params } = makeRig();
  const r = await handlers.apply_sound_intent({ recipeId: "aggressive", trackName: "Serum" });
  assert.ok((await params.drive.getValue()) > 0);
  const undo = await handlers.revert_sound_intent({ token: r.revertToken });
  assert.strictEqual(undo.recipe, "aggressive");
  assert.ok(Math.abs((await params.drive.getValue()) - 0.0) < 1e-9, "drive not restored");
  assert.ok(Math.abs((await params.cutoff.getValue()) - 0.45) < 1e-9, "cutoff not restored");
});

await check("open-loop intent (explore) works WITHOUT the AI Ear track", async () => {
  // `explore` is the open-loop recipe (no audio metric), so it applies its move and reports
  // param deltas without ever rendering — proving the AI Ear track is not required. A fixed
  // seed keeps the seeded random proposer deterministic for the assertion.
  const { handlers } = makeRig({ withEar: false, withLfo: true });
  const r = await handlers.apply_sound_intent({ recipeId: "explore", seed: 21 });
  assert.strictEqual(r.reason, "applied-open-loop");
  assert.strictEqual(r.seed, 21, "explore should echo its seed for reproducibility");
  assert.ok(r.deltas && Object.keys(r.deltas).length > 0, "explore reported no param deltas");
});

await check("closed-loop intent without AI Ear fails with the setup instructions", async () => {
  const { handlers } = makeRig({ withEar: false });
  let msg = "";
  try { await handlers.apply_sound_intent({ recipeId: "brighter" }); } catch (e) { msg = e.message; }
  assert.ok(/AI Ear/.test(msg) && /Monitor/.test(msg), `error not actionable: ${msg}`);
});

await check("list_sound_controls reports found values and missing controls with a fix", async () => {
  const { handlers } = makeRig();
  const r = await handlers.list_sound_controls({ trackName: "Serum" });
  const cut = r.found.find((f) => f.id === "filter.cutoff");
  assert.ok(cut && Math.abs(cut.value - 0.45) < 1e-9);
  const missing = r.missing.find((m) => m.id === "lfo1.rate");
  assert.ok(missing && /Configure Mode/.test(missing.fix), "missing entry lacks fix text");
});

await check("unknown recipeId lists the valid vocabulary", async () => {
  const { handlers } = makeRig();
  let msg = "";
  try { await handlers.apply_sound_intent({ recipeId: "sparklier" }); } catch (e) { msg = e.message; }
  assert.ok(/brighter/.test(msg) && /movement/.test(msg), `unhelpful: ${msg}`);
});

await check("run_code executes with (song, resources, fs) in scope", async () => {
  const { handlers } = makeRig();
  const r = await handlers.run_code({ code: "return song.tracks.map(t => t.name);" });
  assert.deepStrictEqual(r, ["Drums", "Serum Bass", "AI Ear"]);
});

cleanupFakeKernelRig();
console.log(`\n${pass} checks passed`);
