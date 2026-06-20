// In-Live UX for the sound-intent engine: context-menu commands on MIDI tracks that run
// canned recipes through the SAME portable engine the MCP tools use (one code path, two
// front doors). Every command body `.catch()`es — an uncaught rejection kills the
// Extension Host (learned the hard way; see logging.ts).

import fs from "node:fs";
import { MidiTrack, type ApiVersion, type ExtensionContext, type Handle } from "@ableton-extensions/sdk";
import { LiveAdapter } from "./liveAdapter.ts";
import { applyRecipe } from "./intentEngine.ts";
import type { ApplyRecipeOptions, RecipeResult } from "./intentEngine.ts";
import { makeRandomProposer } from "./proposers.ts";
import { RECIPES } from "./recipes.ts";
import { SERUM_PROFILE } from "./profiles.ts";
import { createLogger, describeError } from "./logging.ts";

const logger = createLogger("soundIntents");

// Which synth this extension's menu surface drives. The engine itself is profile-agnostic;
// pointing the menus at another synth is a different profile here, not different code.
const PROFILE = SERUM_PROFILE;

export interface IntentCommand {
  commandId: string;
  label: string;
  recipeId: string;
}

// The canned menu surface (plan.md Phase 4: at minimum Brighter / More Bass / Aggressive /
// Revert). The full recipe vocabulary stays Claude-side via MCP; menus carry the hits —
// plus the seeded "Surprise Me" exploration (the engine-safe successor to the old
// random-twist spike: clamped to safe ranges, logged seed, revertable).
export const INTENT_COMMANDS: IntentCommand[] = [
  { commandId: "soundIntents.brighter", label: "Sound: Brighter", recipeId: "brighter" },
  { commandId: "soundIntents.moreBass", label: "Sound: More Bass", recipeId: "moreBass" },
  { commandId: "soundIntents.aggressive", label: "Sound: More Aggressive", recipeId: "aggressive" },
  { commandId: "soundIntents.surprise", label: "Sound: Surprise Me", recipeId: "explore" },
];

export const REVERT_COMMAND_ID = "soundIntents.revert";
export const REVERT_LABEL = "Sound: Revert Last Intent";

interface LastEdit {
  recipeId: string;
  result: RecipeResult;
}

export function registerSoundIntentCommands(context: ExtensionContext<ApiVersion>): void {
  let lastEdit: LastEdit | null = null;

  function trackFromArgs(args: unknown[]): MidiTrack<ApiVersion> | null {
    const handle = args[0] as Handle | undefined;
    if (handle === undefined) {
      logger.warn("track_resolve_missing_handle", { argCount: args.length });
      return null;
    }
    try {
      return context.getObjectFromHandle(handle, MidiTrack);
    } catch (error) {
      logger.warn("track_resolve_failed", { error: describeError(error) });
      return null;
    }
  }

  async function runIntent(recipeId: string, args: unknown[]): Promise<void> {
    const recipe = RECIPES[recipeId];
    if (!recipe) {
      logger.error("unknown_recipe", { recipeId });
      return;
    }
    // "explore" is non-deterministic by design: a seeded random proposer inside the same
    // safety harness. The seed is logged so any surprise can be reproduced.
    const seed = recipeId === "explore" ? Date.now() >>> 0 : undefined;
    const opts: ApplyRecipeOptions =
      seed !== undefined ? { proposer: makeRandomProposer({ seed }) } : {};

    await context.ui.withinProgressDialog(
      `Applying "${recipeId}"…`,
      { progress: 0 },
      async (update, signal) => {
        const track = trackFromArgs(args);
        if (track === null) return;

        await update(`Resolving ${PROFILE.label} and the AI Ear track…`, 15);
        const adapter = await LiveAdapter.create({
          context,
          track,
          // closed-loop recipes render via the routed "AI Ear" track; open-loop ones don't
          ...(recipe.metric != null ? { song: context.application.song } : {}),
          profile: PROFILE,
          region: PROFILE.defaultRegion,
          fs,
        });
        if (signal.aborted) return;

        await update(`Converging (clamped, damped, max 5 iterations)…`, 40);
        const result = await applyRecipe(adapter, recipe, opts);
        lastEdit = { recipeId, result };

        const summary =
          result.metric != null
            ? `${result.metric} ${result.before!.toFixed(3)} → ${result.after!.toFixed(3)} ` +
              `(×${result.ratio!.toFixed(2)}) [${result.reason}]`
            : `applied ${Object.entries(result.deltas)
                .map(([id, d]) => `${id} ${d.before.toFixed(2)}→${d.after.toFixed(2)}`)
                .join(", ")} [${result.reason}]`;
        logger.info("intent_applied", { recipeId, seed, summary, log: result.log });
        await update(summary, 100);
      }
    );
  }

  async function runRevert(): Promise<void> {
    if (!lastEdit) {
      logger.warn("revert_nothing_to_revert");
      return;
    }
    const edit = lastEdit;
    await context.ui.withinProgressDialog(
      `Reverting "${edit.recipeId}"…`,
      { progress: 50 },
      async (update) => {
        await edit.result.revert();
        lastEdit = null;
        logger.info("intent_reverted", { recipeId: edit.recipeId, restored: edit.result.snapshot });
        await update(`Restored ${Object.keys(edit.result.snapshot).join(", ")}`, 100);
      }
    );
  }

  for (const { commandId, recipeId } of INTENT_COMMANDS) {
    context.commands.registerCommand(commandId, (...args) => {
      runIntent(recipeId, args).catch((error) => {
        logger.error("command_failed", { commandId, error: describeError(error) });
      });
    });
  }

  context.commands.registerCommand(REVERT_COMMAND_ID, (...args) => {
    void args;
    runRevert().catch((error) => {
      logger.error("command_failed", { commandId: REVERT_COMMAND_ID, error: describeError(error) });
    });
  });
}

export async function registerSoundIntentMenus(context: ExtensionContext<ApiVersion>): Promise<void> {
  for (const { commandId, label } of INTENT_COMMANDS) {
    await context.ui.registerContextMenuAction("MidiTrack", label, commandId);
  }
  await context.ui.registerContextMenuAction("MidiTrack", REVERT_LABEL, REVERT_COMMAND_ID);
  logger.info("menus_registered", {
    commands: [...INTENT_COMMANDS.map((c) => c.commandId), REVERT_COMMAND_ID],
  });
}
