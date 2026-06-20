// The sound-intents extension — the in-Live front door to the portable sound-intent
// engine (../../src/*): context-menu commands on MIDI tracks that run recipes through
// applyRecipe, the same code path the MCP tools drive. (This extension started life as a
// "twist a random knob" SDK spike; that proof-of-concept is gone — exploration now runs
// through the engine as the seeded "Surprise Me" intent, clamped and revertable.)

import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { createLogger, describeError } from "./logging.js";
import { registerSoundIntentCommands, registerSoundIntentMenus } from "./soundIntents.js";

const logger = createLogger("soundIntents.extension");

export async function activate(activation: ActivationContext) {
  try {
    logger.info("activate_start", { hostApiVersion: activation.hostApiVersion });

    const context = initialize(activation, "1.0.0");

    registerSoundIntentCommands(context);
    await registerSoundIntentMenus(context);

    logger.info("activate_complete", {});
  } catch (error) {
    logger.error("activate_failed", { error: describeError(error) });
  }
}
