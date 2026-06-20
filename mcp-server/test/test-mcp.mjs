// Offline MCP server tests — a real MCP client talks to the real server over an in-memory
// transport; only the kernel (the Live side) is stubbed. Zero Ableton required.
//   node test/test-mcp.mjs
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.ts";

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

// A canned, well-formed RecipeResult as the kernel's apply_sound_intent would return it.
const cannedApplyResult = {
  recipe: "brighter",
  metric: "centroid",
  before: 800,
  after: 1010,
  ratio: 1.2625,
  reason: "target-met",
  snapshot: { "filter.cutoff": 0.45 },
  deltas: { "filter.cutoff": { before: 0.45, after: 0.61 } },
  beforeAPO: { centroid: 800, highRatio: 0.2, bassRatio: 0.6, rms: 0.4 },
  afterAPO: { centroid: 1010, highRatio: 0.25, bassRatio: 0.55, rms: 0.42 },
  log: [{ iter: 0, metric: 800, controls: { "filter.cutoff": 0.45 } }],
  revertToken: "edit-1",
};

function makeStubKernel(overrides = {}) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method in overrides) return overrides[method](params);
      if (method === "apply_sound_intent") return cannedApplyResult;
      if (method === "list_sound_controls") {
        return { device: "Serum2", found: [{ id: "filter.cutoff", paramName: "A Cutoff", value: 0.45 }], missing: [] };
      }
      return { echoed: { method, params } };
    },
  };
}

async function connectedClient(kernel) {
  const server = createServer(kernel);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

console.log("MCP tool surface:");

await check("all 8 tools are registered with the right safety annotations", async () => {
  const client = await connectedClient(makeStubKernel());
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const expected = [
    "ableton_get_context",
    "ableton_get_track",
    "ableton_get_device",
    "ableton_render_audio",
    "ableton_list_sound_controls",
    "ableton_apply_sound_intent",
    "ableton_revert_sound_intent",
    "ableton_run_code",
  ];
  for (const name of expected) assert.ok(byName[name], `missing tool ${name}`);
  for (const name of expected.slice(0, 5)) {
    assert.strictEqual(byName[name].annotations?.readOnlyHint, true, `${name} should be read-only`);
  }
  assert.strictEqual(byName.ableton_run_code.annotations?.destructiveHint, true);
  assert.strictEqual(byName.ableton_run_code.annotations?.openWorldHint, true);
  assert.strictEqual(byName.ableton_apply_sound_intent.annotations?.readOnlyHint, false);
  assert.strictEqual(byName.ableton_apply_sound_intent.annotations?.destructiveHint, false);
});

await check("apply tool description carries the full recipe catalog (the planner contract)", async () => {
  const client = await connectedClient(makeStubKernel());
  const { tools } = await client.listTools();
  const apply = tools.find((t) => t.name === "ableton_apply_sound_intent");
  for (const id of ["brighter", "darker", "moreBass", "lessBass", "aggressive", "softer", "wider", "movement"]) {
    assert.ok(apply.description.includes(`"${id}"`), `catalog missing recipe ${id}`);
  }
  assert.ok(/intensity/i.test(apply.description), "no intensity guidance");
  assert.ok(/AI Ear/.test(apply.description), "no ear-track requirement note");
});

console.log("apply_sound_intent through a stubbed bridge:");

await check("returns the well-formed RecipeResult from the kernel", async () => {
  const kernel = makeStubKernel();
  const client = await connectedClient(kernel);
  const res = await client.callTool({
    name: "ableton_apply_sound_intent",
    arguments: { recipeId: "brighter", intensity: 0.5, trackName: "Serum" },
  });
  assert.ok(!res.isError, `unexpected error: ${JSON.stringify(res.content)}`);
  const r = res.structuredContent;
  assert.strictEqual(r.recipe, "brighter");
  assert.strictEqual(r.reason, "target-met");
  assert.strictEqual(r.revertToken, "edit-1");
  assert.ok(r.beforeAPO.centroid < r.afterAPO.centroid);
  assert.ok(r.deltas["filter.cutoff"].after > r.deltas["filter.cutoff"].before);
  // and the kernel saw the right method + args
  const call = kernel.calls.find((c) => c.method === "apply_sound_intent");
  assert.strictEqual(call.params.recipeId, "brighter");
  assert.strictEqual(call.params.intensity, 0.5);
});

await check("unknown recipe id is rejected cleanly before reaching the kernel", async () => {
  const kernel = makeStubKernel();
  const client = await connectedClient(kernel);
  const res = await client.callTool({
    name: "ableton_apply_sound_intent",
    arguments: { recipeId: "sparklier" },
  });
  assert.strictEqual(res.isError, true, "invalid recipeId was accepted");
  const text = res.content[0].text;
  // the error must teach the caller the valid vocabulary
  assert.ok(/invalid/i.test(text) && /brighter/.test(text) && /moreBass/.test(text), `unhelpful error: ${text}`);
  assert.strictEqual(kernel.calls.length, 0, "invalid call must not reach the kernel");
});

await check("out-of-range intensity is rejected by the schema", async () => {
  const kernel = makeStubKernel();
  const client = await connectedClient(kernel);
  const res = await client.callTool({
    name: "ableton_apply_sound_intent",
    arguments: { recipeId: "brighter", intensity: 7 },
  });
  assert.strictEqual(res.isError, true, "intensity 7 was accepted");
  assert.strictEqual(kernel.calls.length, 0, "invalid call must not reach the kernel");
});

console.log("error surfaces:");

await check("kernel-unreachable becomes an actionable tool error, not a crash", async () => {
  const kernel = {
    call: async () => {
      throw new Error(
        "cannot reach the Ableton SDK MCP kernel at ws://127.0.0.1:17890 (connection failed). " +
        "Is Ableton Live running with the abletonSdkMcpKernel extension loaded?"
      );
    },
  };
  const client = await connectedClient(kernel);
  const res = await client.callTool({ name: "ableton_get_context", arguments: {} });
  assert.strictEqual(res.isError, true);
  const text = res.content[0].text;
  assert.ok(/ws:\/\/127\.0\.0\.1:17890/.test(text) && /Live/.test(text), `not actionable: ${text}`);
});

await check("kernel-side errors (e.g. missing AI Ear) pass through verbatim", async () => {
  const kernel = makeStubKernel({
    apply_sound_intent: () => {
      throw new Error('no audio track matching "AI Ear" found to render from…');
    },
  });
  const client = await connectedClient(kernel);
  const res = await client.callTool({
    name: "ableton_apply_sound_intent",
    arguments: { recipeId: "brighter" },
  });
  assert.strictEqual(res.isError, true);
  assert.ok(/AI Ear/.test(res.content[0].text));
});

console.log("read tools:");

await check("list_sound_controls proxies and returns the exposure report", async () => {
  const client = await connectedClient(makeStubKernel());
  const res = await client.callTool({ name: "ableton_list_sound_controls", arguments: {} });
  assert.ok(!res.isError);
  assert.strictEqual(res.structuredContent.device, "Serum2");
  assert.strictEqual(res.structuredContent.found[0].id, "filter.cutoff");
});

await check("revert tool forwards the token", async () => {
  const kernel = makeStubKernel({
    revert_sound_intent: (params) => ({ token: params.token, restored: { "filter.cutoff": 0.45 } }),
  });
  const client = await connectedClient(kernel);
  const res = await client.callTool({
    name: "ableton_revert_sound_intent",
    arguments: { token: "edit-7" },
  });
  assert.ok(!res.isError);
  assert.strictEqual(res.structuredContent.token, "edit-7");
});

console.log(`\n${pass} checks passed`);
