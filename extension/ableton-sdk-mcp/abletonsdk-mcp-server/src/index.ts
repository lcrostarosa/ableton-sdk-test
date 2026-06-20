// The Ableton SDK MCP server — the LLM seam. A stdio MCP process (run by Claude Code) that
// proxies typed tools to the kernel extension inside Live over the WebSocket bridge.
//
// LAYERING (matches SYSTEM_ARCHITECTURE.md and plan.md Phase 3): Claude is the L4 planner —
// it reads the recipe catalog in the tool descriptions, maps free text ("make it brighter,
// but subtle") onto {recipeId, intensity}, and reads the returned APO deltas to decide
// whether to re-invoke. Recipes are the L3 contract; the convergence loop runs entirely
// inside Live. This process never imports @ableton-extensions/sdk.
//
// stdio discipline: stdout belongs to the MCP transport — all diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RECIPES } from "../../../../src/recipes.ts";
import { DEFAULT_PROFILE, PROFILES } from "../../../../src/profiles.ts";
import { KernelClient, BRIDGE_URL } from "./kernel-client.ts";
import type { KernelCaller } from "./kernel-client.ts";
import {
  applyIntentShape,
  getDeviceShape,
  regionShape,
  revertShape,
  runCodeShape,
  synthShape,
  trackRefShape,
} from "./schemas.ts";

const MAX_TEXT_CHARS = 30_000;

// The recipe catalog, rendered into the apply tool's description — this is how the planner
// (Claude) learns the vocabulary without an extra round-trip.
const recipeCatalog = Object.values(RECIPES)
  .map((r) => {
    const mode =
      r.metric != null && r.targetRatio != null
        ? `closed-loop: drives ${r.metric} ${r.targetRatio > 1 ? "up" : "down"} toward ×${r.targetRatio}, verified by ear`
        : "open-loop: applies the move and reports param deltas (no audio metric in v1)";
    const knobs = r.controls.map((c) => `${c.id}${c.dir > 0 ? "+" : "-"}`).join(", ");
    return `- "${r.id}" (${knobs}) — ${r.description} [${mode}]`;
  })
  .join("\n");

const controlCatalog = DEFAULT_PROFILE.controls.map((c) => `${c.id} (${c.label})`).join(", ");

const synthCatalog = Object.values(PROFILES)
  .map((p) => `"${p.id}" (${p.label})`)
  .join(", ");

interface ToolResultShape {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(result: unknown): ToolResultShape {
  let text = JSON.stringify(result, null, 2) ?? "null";
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + `\n… truncated at ${MAX_TEXT_CHARS} chars`;
  }
  const out: ToolResultShape = { content: [{ type: "text", text }] };
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    out.structuredContent = result as Record<string, unknown>;
  }
  return out;
}

function err(e: unknown): ToolResultShape {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Build the MCP server against any kernel transport. Production wires a KernelClient;
 * tests pass a stub, so every tool path is exercisable with zero Ableton.
 */
export function createServer(kernel: KernelCaller): McpServer {
  const server = new McpServer({ name: "ableton-sdk-mcp", version: "0.2.0" });

  const proxy =
    (method: string) =>
    async (args: Record<string, unknown>): Promise<ToolResultShape> => {
      try {
        return ok(await kernel.call(method, args));
      } catch (e) {
        return err(e);
      }
    };

  server.registerTool(
    "ableton_get_context",
    {
      title: "Get Live Set overview",
      description:
        "Summary of the current Ableton Live Set: tempo and every track's index, name, type, " +
        "and device names, plus the available synth profiles. Start here to find the synth's " +
        "track and check the 'AI Ear' render track exists. Synth profiles: " + synthCatalog + ".",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    proxy("get_context")
  );

  server.registerTool(
    "ableton_get_track",
    {
      title: "Get track detail",
      description: "One track's devices with parameter counts.",
      inputSchema: { ...trackRefShape, ...synthShape },
      annotations: { readOnlyHint: true },
    },
    proxy("get_track")
  );

  server.registerTool(
    "ableton_get_device",
    {
      title: "Get device parameters",
      description:
        "A device's exposed parameters (name/min/max, optionally current values). Bounded by " +
        "maxParams. VST parameters appear only after being exposed via Live's Configure Mode.",
      inputSchema: getDeviceShape,
      annotations: { readOnlyHint: true },
    },
    proxy("get_device")
  );

  server.registerTool(
    "ableton_render_audio",
    {
      title: "Render and measure a track region",
      description:
        "Render an AUDIO track's arrangement region to WAV and return its full APO measurement: " +
        "spectral centroid, high-band ratio, bass-band ratio, rms, crest factor, K-weighted " +
        "loudness (LUFS), spectral flux (movement), stereo width, inter-channel correlation, " +
        "sub-band (<120 Hz) correlation, and a coarse 8×8 time×frequency spectrogram grid. " +
        "MIDI tracks cannot be rendered — use the routed 'AI Ear' audio track that monitors the synth.",
      inputSchema: { ...trackRefShape, ...regionShape, ...synthShape },
      annotations: { readOnlyHint: true },
    },
    proxy("render_audio")
  );

  server.registerTool(
    "ableton_list_sound_controls",
    {
      title: "List sound controls (exposure check)",
      description:
        "Check which of the synth profile's sound controls resolve on the device, with current " +
        `normalized values. Default profile's registry: ${controlCatalog}. Unresolved controls ` +
        "come back under `missing` with Configure-Mode instructions — run this before the first " +
        "apply_sound_intent on a new Live Set.",
      inputSchema: { ...trackRefShape, ...synthShape },
      annotations: { readOnlyHint: true },
    },
    proxy("list_sound_controls")
  );

  server.registerTool(
    "ableton_apply_sound_intent",
    {
      title: "Apply a sound-shaping intent",
      description:
        "Run a semantic sound change on the synth as a measured convergence loop inside Live " +
        "(steps clamped to safe ranges, damped, iteration-capped, constraint-guarded). " +
        "Returns before/after scalar audio measurements (centroid, high/bass ratios, rms, " +
        "crest, loudness LUFS, flux, stereo width/correlation), the per-control deltas, the " +
        "stop reason, and a revertToken. (The coarse spectrogram grid is on render_audio only.)" +
        "\n\nRecipe catalog:\n" + recipeCatalog + "\n\n" +
        "Choosing: map the user's words to ONE recipe; scale `intensity` to how strongly they " +
        "asked (\"a touch brighter\" → 0.3, \"way brighter\" → 1). After it returns, read " +
        "`beforeAPO`/`afterAPO` and `reason` — re-invoke with adjusted intensity if the " +
        "change under- or overshot, or call revert if the user dislikes it. " +
        "`reason: constraint-blocked:<metric>` means the guard (e.g. loudness) vetoed " +
        "further movement. \"explore\" is the non-deterministic path: a seeded random walk " +
        "inside the same safety harness — the result carries `seed`, so re-invoking with " +
        "that seed replays the identical variation. Closed-loop recipes need the routed " +
        "'AI Ear' audio track; its absence returns setup instructions.",
      inputSchema: applyIntentShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    proxy("apply_sound_intent")
  );

  server.registerTool(
    "ableton_revert_sound_intent",
    {
      title: "Revert a sound intent",
      description:
        "Restore the parameter snapshot taken before an apply_sound_intent run (the given " +
        "token, or the most recent one). This is the \"undo that\" path.",
      inputSchema: revertShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    proxy("revert_sound_intent")
  );

  server.registerTool(
    "ableton_run_code",
    {
      title: "Run code in Live (advanced)",
      description:
        "Escape hatch: execute JavaScript inside Live's extension host with (song, resources, " +
        "fs) in scope. Prefer the typed tools above for sound workflows; use this for " +
        "exploration the tools don't cover. Mutations are NOT snapshot-protected.",
      inputSchema: runCodeShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    proxy("run_code")
  );

  return server;
}

// stdio entry point — skipped under test (tests import createServer directly).
export async function main(): Promise<void> {
  const kernel = new KernelClient();
  const server = createServer(kernel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[ableton-sdk-mcp] ready (kernel bridge: ${BRIDGE_URL})`);
}

const entryHref = process.argv[1] ? (await import("node:url")).pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref) {
  main().catch((e) => {
    console.error("[ableton-sdk-mcp] fatal:", e);
    process.exit(1);
  });
}
