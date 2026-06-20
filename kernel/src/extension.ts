// The MCP kernel extension — a WebSocket bridge inside Live's Extension Host.
// activate() starts a ws server on 127.0.0.1:17890; the stdio MCP server (run by Claude
// Code) connects and proxies tool calls as BridgeRequests. Handlers (handlers.ts) own all
// Live API access. Every async body catches: an uncaught rejection kills the Extension Host.

import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
// `ws` is imported LAZILY inside activate() (dynamic import below). A static import makes
// esbuild evaluate the whole ws library — and its eager require("net"/"http"/"tls"/...) — at
// MODULE LOAD, before any of our code runs. If Live's Extension Host hands extensions a
// restricted require that doesn't whitelist one of those builtins, the module throws while
// loading and activate() is never called (symptom: host logs "Started" then nothing, bridge
// port never opens). Deferring keeps module load trivial so activate() always runs and any
// transport failure is caught and logged instead of silently killing the load.
import type { WebSocket } from "ws";
import { makeHandlers, type Handlers } from "./handlers.ts";
import { BRIDGE_HOST, BRIDGE_PORT, type BridgeRequest, type BridgeResponse } from "./protocol.ts";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === undefined) return "undefined (bare rejection — see Spike B in the README)";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function log(event: string, data?: unknown) {
  const suffix = data === undefined ? "" : " " + JSON.stringify(data);
  console.log(`[abletonSdkMcpKernel] ${event}${suffix}`);
}

// Module-scope marker: proves the host successfully required this entry. If you see this but
// never see "activate_called", the host loaded the module but isn't calling activate (export
// shape). If you see neither, the host never required this entry (manifest/registration).
log("module_evaluated");

async function dispatch(handlers: Handlers, req: BridgeRequest): Promise<BridgeResponse> {
  const method = req.method as keyof Handlers;
  const handler = handlers[method];
  if (typeof handler !== "function") {
    return { id: req.id, ok: false, error: `unknown method "${req.method}"` };
  }
  try {
    // params are validated by the MCP server's zod schemas; handlers re-check what matters
    const result = await (handler as (p: unknown) => Promise<unknown>)(req.params ?? {});
    return { id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, error: describeError(e) };
  }
}

export async function activate(activation: ActivationContext) {
  log("activate_called");
  try {
    log("initializing_context");
    const context = initialize(activation, "1.0.0");
    log("context_initialized", { hasApplication: !!context.application, hasResources: !!context.resources });

    const handlers = makeHandlers({
      resources: context.resources,
      getSong: () => context.application.song,
    });
    log("handlers_created");

    log("loading_ws");
    const { WebSocketServer } = await import("ws");
    log("starting_wss", { host: BRIDGE_HOST, port: BRIDGE_PORT });
    const wss = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });

    wss.on("listening", () => log("bridge_listening", { url: `ws://${BRIDGE_HOST}:${BRIDGE_PORT}` }));
    wss.on("error", (e: unknown) => log("bridge_error", { error: describeError(e) }));

    wss.on("connection", (socket: WebSocket) => {
      log("client_connected");
      socket.on("message", (raw: unknown) => {
        void (async () => {
          let req: BridgeRequest;
          try {
            req = JSON.parse(String(raw)) as BridgeRequest;
          } catch (e) {
            log("bad_request_json", { error: describeError(e) });
            socket.send(JSON.stringify({ id: -1, ok: false, error: "request is not valid JSON" }));
            return;
          }
          log("request", { id: req.id, method: req.method });
          const res = await dispatch(handlers, req);
          if (!res.ok) log("request_failed", { id: req.id, method: req.method, error: res.error });
          try {
            socket.send(JSON.stringify(res));
          } catch (e) {
            log("send_failed", { id: req.id, error: describeError(e) });
          }
        })().catch((e) => log("dispatch_crashed", { error: describeError(e) }));
      });
      socket.on("close", () => log("client_disconnected"));
      socket.on("error", (e: unknown) => log("client_socket_error", { error: describeError(e) }));
    });
  } catch (error) {
    log("activate_failed", { error: describeError(error) });
  }
}
