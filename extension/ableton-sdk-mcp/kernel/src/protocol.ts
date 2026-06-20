// The bridge wire protocol between the MCP server (stdio process in Claude Code) and this
// kernel (WebSocket server inside Live's Extension Host). JSON text frames, one
// request/response pair per id — deliberately JSON-RPC-shaped but smaller.
//
// RUNTIME BOUNDARY (the rule everything else hangs off): all Live API access happens HERE,
// in the extension host. The MCP server only validates inputs, proxies method calls over
// this protocol, and shapes results. It must never import @ableton-extensions/sdk.

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 17890;
export const BRIDGE_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`;

export interface BridgeRequest {
  id: number;
  method: string;
  params?: Record<string, unknown> | undefined;
}

export type BridgeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// Kernel methods (the MCP tools map 1:1 onto these).
export type BridgeMethod =
  | "get_context"
  | "get_track"
  | "get_device"
  | "render_audio"
  | "list_sound_controls"
  | "apply_sound_intent"
  | "revert_sound_intent"
  | "run_code";
