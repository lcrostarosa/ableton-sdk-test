// Exercises the REAL LiveAdapter code (device/param resolution, [min,max]<->0..1
// normalization, AI-Ear render-track resolution, render→decode→measure) against FAKE SDK
// objects — so the live path is verified with zero Ableton. The fakes are doubles for the
// real `@ableton-extensions/sdk` types (cast at the edge); only renderPreFxAudio and the
// DeviceParameters are stubbed — everything in liveAdapter.ts runs for real.
//   node ideas/demo/liveAdapter.test.ts
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { LiveAdapter, RENDER_TRACK_NAME } from "../src/common/liveAdapter.ts";
import type { SdkResources, SdkSong, SdkTrack } from "../src/common/liveAdapter.ts";
import { applyRecipe } from "../src/common/intentEngine.ts";
import { makeRandomProposer } from "../src/common/proposers.ts";
import { RECIPES } from "../src/common/recipes.ts";
import {
  FakeMidiTrackShape,
  fakeDevice,
  fakeParam,
  fakeTrack,
  makeFakeRig,
} from "./fixtures/liveSdk/fakeLiveRig.ts";

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

console.log("LiveAdapter against a fake SDK:");

const tmpDir = path.join(import.meta.dirname, ".tmp_test");
fs.mkdirSync(tmpDir, { recursive: true });
const tmpWav = path.join(tmpDir, "render.wav");
const region = { startBeat: 0, endBeat: 1 };

await check(
  "resolves Serum's cutoff param and reads it normalized",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const n = await a.get("filter.cutoff");
    assert(Math.abs(n - 0.45) < 1e-9, `get("filter.cutoff") returned ${n}`);
  },
);

await check("set normalizes into [min,max] and round-trips", async () => {
  const { context, track, song } = makeFakeRig(tmpWav);
  const a = await LiveAdapter.create({ context, track, song, region, fs });
  await a.set("filter.cutoff", 0.7);
  assert(
    Math.abs((await a.get("filter.cutoff")) - 0.7) < 1e-9,
    "round-trip failed",
  );
});

console.log("render-track (AI Ear) resolution:");

await check(
  'renders from the audio track named "AI Ear", not the Serum track',
  async () => {
    const { context, track, song, renderedTracks } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    await a.measure();
    assert.deepStrictEqual(
      renderedTracks,
      [RENDER_TRACK_NAME],
      `rendered: ${renderedTracks}`,
    );
  },
);

await check("ear-name matching is a case-insensitive substring", async () => {
  const { context, track, song, renderedTracks } = makeFakeRig(tmpWav, {
    earName: "2 ai ear (routed)",
  });
  const a = await LiveAdapter.create({ context, track, song, region, fs });
  await a.measure();
  assert.deepStrictEqual(renderedTracks, ["2 ai ear (routed)"]);
});

await check('missing "AI Ear" track → actionable setup error', async () => {
  const { context, track, song } = makeFakeRig(tmpWav, { earName: null });
  let msg = "";
  try {
    await LiveAdapter.create({ context, track, song, region, fs });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(
    /AI Ear/.test(msg) && /Audio From/.test(msg) && /Monitor/.test(msg),
    `error not actionable: ${msg}`,
  );
});

await check(
  'a MIDI track named "AI Ear" is rejected with an explanation',
  async () => {
    const rig = makeFakeRig(tmpWav, { earName: null });
    const midiEar = new FakeMidiTrackShape("AI Ear") as unknown as SdkTrack;
    const song = {
      get tracks() {
        return [rig.track, midiEar];
      },
    } as unknown as SdkSong;
    let msg = "";
    try {
      await LiveAdapter.create({
        context: rig.context,
        track: rig.track,
        song,
        region,
        fs,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(/not an audio track/.test(msg), `error not actionable: ${msg}`);
  },
);

await check(
  "no song (back-compat): MIDI-track render rejection is rethrown actionably",
  async () => {
    const { track } = makeFakeRig(tmpWav);
    const resources = {
      // the Spike-B failure mode: the native bridge rejects with a bare `undefined`
      renderPreFxAudio: async () => {
        throw undefined;
      },
    } as unknown as SdkResources;
    const a = await LiveAdapter.create({
      context: { resources },
      track,
      region,
      fs,
    });
    let msg = "";
    try {
      await a.measure();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(
      /renderPreFxAudio/.test(msg) && /AI Ear/.test(msg),
      `error not actionable: ${msg}`,
    );
  },
);

console.log("measure/engine through the real adapter path:");

await check(
  "measure() renders and decodes the WAV into a centroid",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const apo = await a.measure();
    assert(
      apo.centroid > 0 && isFinite(apo.centroid),
      `bad centroid ${apo.centroid}`,
    );
  },
);

await check(
  "brighter recipe converges through the real adapter path",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const r = await applyRecipe(a, { ...RECIPES.brighter!, targetRatio: 1.2 });
    assert(r.after! > r.before!, "centroid did not increase");
    assert(r.log.length <= 6, "loop not bounded");
    assert(
      (await a.get("filter.cutoff")) <= 0.88 + 1e-9,
      "exceeded safe range",
    );
  },
);

await check(
  "missing param: create succeeds, first use gives the Configure-Mode hint",
  async () => {
    const device = fakeDevice("Serum2", () => [
      fakeParam("A Octave", -4, 4, 0),
    ]);
    const track = fakeTrack("Serum Bass", [device]);
    const resources = {
      renderPreFxAudio: async () => {
        throw new Error("should not render");
      },
    } as unknown as SdkResources;
    const a = await LiveAdapter.create({
      context: { resources },
      track,
      region,
      fs,
    });
    let msg = "";
    try {
      await a.get("filter.cutoff");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(/Configure Mode/.test(msg), `error not actionable: ${msg}`);
  },
);

await check(
  "generic get/set resolves fx.drive and the new controls, and round-trips",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    await a.set("fx.drive", 0.6);
    assert(
      Math.abs((await a.get("fx.drive")) - 0.6) < 1e-9,
      "drive round-trip failed",
    );
    await a.set("sub.level", 0.5);
    assert(
      Math.abs((await a.get("sub.level")) - 0.5) < 1e-9,
      "sub.level round-trip failed",
    );
    await a.set("osc.detune", 0.3);
    assert(
      Math.abs((await a.get("osc.detune")) - 0.3) < 1e-9,
      "osc.detune round-trip failed",
    );
  },
);

await check(
  "resolveControls partitions found vs missing (exposure check)",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const r = await a.resolveControls([
      "filter.cutoff",
      "sub.level",
      "lfo1.rate",
    ]);
    assert.deepStrictEqual(
      r.found.map((f) => f.id),
      ["filter.cutoff", "sub.level"],
    );
    assert.strictEqual(r.missing.length, 1);
    assert.strictEqual(r.missing[0]!.id, "lfo1.rate"); // the fake rig exposes no LFO param
    assert(
      /Configure Mode/.test(r.missing[0]!.error),
      "missing entry lacks the Configure-Mode hint",
    );
  },
);

await check(
  "measure() returns an APO (centroid/highRatio/bassRatio/rms)",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const apo = await a.measure();
    for (const k of ["centroid", "highRatio", "bassRatio", "rms"] as const) {
      assert(
        typeof apo[k] === "number" && isFinite(apo[k]),
        `bad ${k}: ${apo[k]}`,
      );
    }
  },
);

await check(
  "aggressive recipe drives the REAL adapter multi-knob (highRatio rises)",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const r = await applyRecipe(a, RECIPES.aggressive!);
    assert(
      r.after! > r.before!,
      `highRatio did not rise (${r.before} -> ${r.after})`,
    );
    assert(
      (await a.get("fx.drive")) > 0 && (await a.get("filter.reso")) > 0.1,
      "drive/reso not engaged",
    );
  },
);

await check(
  "moreBass recipe raises bassRatio through the REAL adapter",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    const r = await applyRecipe(a, RECIPES.moreBass!);
    assert(
      r.after! > r.before!,
      `bassRatio did not rise (${r.before} -> ${r.after})`,
    );
  },
);

await check(
  "seeded explore drives the REAL adapter and reverts cleanly",
  async () => {
    const { context, track, song } = makeFakeRig(tmpWav);
    const a = await LiveAdapter.create({ context, track, song, region, fs });
    // the fake rig exposes no LFO param — explore must fail only for that control's id
    const recipe = {
      ...RECIPES.explore!,
      controls: RECIPES.explore!.controls.filter((c) => c.id !== "lfo1.rate"),
    };
    const before = await a.get("filter.cutoff");
    const r = await applyRecipe(a, recipe, {
      proposer: makeRandomProposer({ seed: 21 }),
    });
    assert.strictEqual(r.reason, "applied-open-loop");
    await r.revert();
    assert(
      Math.abs((await a.get("filter.cutoff")) - before) < 1e-9,
      "revert did not restore cutoff",
    );
  },
);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
