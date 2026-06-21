// WebSocket client for the kernel bridge. Lazy-connects on first call, matches responses
// to requests by id, and times out hung calls. Node >= 22 ships a global WebSocket
// (undici), so this process needs no ws dependency.
//
// This file deliberately knows nothing about Live: it speaks the protocol
// (kernel/src/protocol.ts) and nothing else.

export const BRIDGE_URL = "ws://127.0.0.1:17890";

export interface KernelCaller {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface BridgeResponseShape {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class KernelUnreachableError extends Error {
  constructor(url: string, cause: string) {
    super(
      `cannot reach the Ableton SDK MCP kernel at ${url} (${cause}). ` +
      `Is Ableton Live running with the abletonSdkMcpKernel extension loaded? ` +
      `Build it with "npm run build" in ableton-sdk-mcp/kernel and add it in ` +
      `Live's Preferences → Plug-Ins → Extensions.`
    );
    this.name = "KernelUnreachableError";
  }
}

export class KernelClient implements KernelCaller {
  private url: string;
  private timeoutMs: number;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(url: string = BRIDGE_URL, timeoutMs = 120_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  private failAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (e) {
        reject(new KernelUnreachableError(this.url, e instanceof Error ? e.message : String(e)));
        return;
      }
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => {
        reject(new KernelUnreachableError(this.url, "connection failed"));
      });
      socket.addEventListener("close", () => {
        if (this.ws === socket) this.ws = null;
        this.failAllPending(new KernelUnreachableError(this.url, "connection closed mid-call"));
      });
      socket.addEventListener("message", (ev) => {
        let res: BridgeResponseShape;
        try {
          res = JSON.parse(String(ev.data)) as BridgeResponseShape;
        } catch {
          return; // not ours; ignore
        }
        const entry = this.pending.get(res.id);
        if (!entry) return;
        this.pending.delete(res.id);
        if (res.ok) entry.resolve(res.result);
        else entry.reject(new Error(res.error ?? "kernel returned an unspecified error"));
      });
    });
  }

  private async ensure(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    this.ws = await this.connect();
    return this.ws;
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const socket = await this.ensure();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`kernel call "${method}" timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
