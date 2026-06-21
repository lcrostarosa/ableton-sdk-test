// Merged Ableton extension: sound-intent context menus + WebSocket bridge for MCP tools.
// A single activate() sets up both doors to the portable engine:
//   1. Sound intent commands on MIDI tracks (the in-Live UI path, via soundIntents.ts)
//   2. WebSocket bridge at ws://127.0.0.1:17890 (the MCP path, via handlers.ts)
//
// ws is imported LAZILY inside activate() — a static import makes esbuild evaluate the
// whole ws library at MODULE LOAD, before any of our code runs. If Live's Extension Host
// uses a restricted require that doesn't whitelist net/http/tls, the module throws while
// loading and activate() is never called. Deferring keeps module load trivial so any
// transport failure is caught and logged instead of silently killing the load.

import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import type { WebSocket } from "ws";
import { createLogger, describeError } from "./logging.js";
import { registerSoundIntentCommands, registerSoundIntentMenus } from "./soundIntents.js";
import { makeHandlers, type Handlers } from "./handlers.js";
import { BRIDGE_HOST, BRIDGE_PORT, type BridgeRequest, type BridgeResponse } from "./protocol.js";

const logger = createLogger("extension");
logger.info("module_evaluated");

async function dispatch(handlers: Handlers, req: BridgeRequest): Promise<BridgeResponse> {
  const method = req.method as keyof Handlers;
  const handler = handlers[method];
  if (typeof handler !== "function") {
    return { id: req.id, ok: false, error: `unknown method "${req.method}"` };
  }
  try {
    const result = await (handler as (p: unknown) => Promise<unknown>)(req.params ?? {});
    return { id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, error: describeError(e).message ?? String(e) };
  }
}

export async function activate(activation: ActivationContext) {
  try {
    logger.info("activate_start", { hostApiVersion: activation.hostApiVersion });

    const context = initialize(activation, "1.0.0");

    // Sound-intent menus (in-Live UI path)
    registerSoundIntentCommands(context);
    await registerSoundIntentMenus(context);

    // WebSocket bridge (MCP path)
    const { WebSocketServer } = await import("ws");
    const handlers = makeHandlers({
      resources: context.resources,
      getSong: () => context.application.song,
    });
    const wss = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });

    wss.on("listening", () => logger.info("bridge_listening", { url: `ws://${BRIDGE_HOST}:${BRIDGE_PORT}` }));
    wss.on("error", (e: unknown) => logger.error("bridge_error", { error: describeError(e) }));

    wss.on("connection", (socket: WebSocket) => {
      logger.info("client_connected");
      socket.on("message", (raw: unknown) => {
        void (async () => {
          let req: BridgeRequest;
          try {
            req = JSON.parse(String(raw)) as BridgeRequest;
          } catch (e) {
            logger.error("bad_request_json", { error: describeError(e) });
            socket.send(JSON.stringify({ id: -1, ok: false, error: "request is not valid JSON" }));
            return;
          }
          logger.info("request", { id: req.id, method: req.method });
          const res = await dispatch(handlers, req);
          if (!res.ok) logger.error("request_failed", { id: req.id, method: req.method, error: res.error });
          try {
            socket.send(JSON.stringify(res));
          } catch (e) {
            logger.error("send_failed", { id: req.id, error: describeError(e) });
          }
        })().catch((e) => logger.error("dispatch_crashed", { error: describeError(e) }));
      });
      socket.on("close", () => logger.info("client_disconnected"));
      socket.on("error", (e: unknown) => logger.error("client_socket_error", { error: describeError(e) }));
    });

    logger.info("activate_complete");
  } catch (error) {
    logger.error("activate_failed", { error: describeError(error) });
  }
}
