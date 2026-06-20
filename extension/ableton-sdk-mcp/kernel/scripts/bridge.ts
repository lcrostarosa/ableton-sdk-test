// Robust launcher for the kernel's WebSocket bridge — the thing the MCP tools actually need
// up. `extensions-cli run` (the SDK's generic dev runner) only knows "load the extension and
// connect to Live"; it has no idea this kernel opens a bridge on a specific port, can't tell a
// healthy host from one wedged mid-connect, and won't clean up a stale sibling. That gap is
// what this script fills, in TypeScript instead of brittle shell, so it can:
//   - reuse the real port from src/protocol.ts (no hardcoded 17890 to drift)
//   - probe readiness with an actual socket connect (not lsof/nc output parsing)
//   - find + kill a stale host via structured `ps` + process.kill (no pipe-grep guesswork)
//   - resolve on the true signal: a successful connect OR the host's `bridge_listening` log
//
// Lifecycle: build → (kill stale) → spawn host → wait for the bridge → stay foreground,
// streaming the host log, until Ctrl-C (which stops the host). Idempotent: if the bridge is
// already up it exits clean unless you pass --restart.
//
// Run: `npm run bridge`  (or `npm run bridge:restart` to force a fresh host)

import net from "node:net";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BRIDGE_HOST, BRIDGE_PORT, BRIDGE_URL } from "../src/protocol.ts";

const execFileP = promisify(execFile);

// kernel root = one level up from scripts/, resolved off this file so it works regardless of cwd
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const EXTENSIONS_CLI = path.join(ROOT, "node_modules", ".bin", "extensions-cli");

const RESTART = process.argv.includes("--restart");
const READY_TIMEOUT_MS = 30_000;
const READY_LOG_MARKER = "bridge_listening";

const log = (msg: string) => console.log(`[bridge] ${msg}`);

// The real readiness question: can something accept a TCP connection on the bridge port?
function probe(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: BRIDGE_HOST, port: BRIDGE_PORT });
    const settle = (up: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(up);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
    sock.setTimeout(timeoutMs, () => settle(false));
  });
}

// Structured process discovery — `ps` via execFile (argv, not a shell string), parsed in JS.
// Matches BOTH processes that host THIS kernel: the `extensions-cli run` wrapper AND the
// `ExtensionHost/node` it spawns — the latter is what actually binds the port, and it can
// outlive its parent (we've seen it reparented to launchd as PPID 1). Both command lines
// embed this kernel's path, so scoping to ROOT keeps us from killing another extension's host.
async function findHostPids(): Promise<number[]> {
  try {
    const { stdout } = await execFileP("ps", ["-axo", "pid=,command="]);
    return stdout
      .split("\n")
      .filter((line) => line.includes(ROOT) && (line.includes("extensions-cli") || line.includes("ExtensionHost")))
      .map((line) => Number.parseInt(line.trim().split(/\s+/)[0], 10))
      .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

// Bring any existing host for this kernel down and GUARANTEE the port is free on return —
// otherwise throw. This is what lets waitForBridge trust a probe: after killStale succeeds,
// nothing else can be answering on the port, so a connect means our new host bound it.
async function killStale(): Promise<void> {
  let pids = await findHostPids();
  if (pids.length === 0 && !(await probe(300))) return;
  if (pids.length) {
    log(`stopping stale host(s): ${pids.join(", ")}`);
    for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }

  // wait for them to die and the port to free
  for (let i = 0; i < 20; i++) {
    if ((await findHostPids()).length === 0 && !(await probe(300))) return;
    await sleep(250);
  }
  // escalate anything still standing
  pids = await findHostPids();
  for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await sleep(500);

  if (await probe(300)) {
    throw new Error(
      `port ${BRIDGE_PORT} is still held after stopping this kernel's host(s) — something outside this project may own it (inspect with: lsof -nP -iTCP:${BRIDGE_PORT})`,
    );
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args.join(" ")} exited with code ${code}`)),
    );
  });
}

// Resolve on the FIRST of: a successful port probe, the host logging bridge_listening.
// Reject if the host exits early or we hit the timeout.
function waitForBridge(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
    const fail = (err: Error) => { if (!settled) { settled = true; cleanup(); reject(err); } };

    const timer = setTimeout(
      () => fail(new Error(`timed out after ${READY_TIMEOUT_MS / 1000}s waiting for ${BRIDGE_URL} — is Live running with this Set open?`)),
      READY_TIMEOUT_MS,
    );
    const poll = setInterval(() => { void probe(500).then((up) => up && ok()); }, 500);
    const onLog = (buf: Buffer) => { if (buf.toString().includes(READY_LOG_MARKER)) ok(); };
    const onExit = (code: number | null) => fail(new Error(`host exited (code ${code}) before the bridge came up`));

    child.stdout?.on("data", onLog);
    child.stderr?.on("data", onLog);
    child.once("exit", onExit);

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
      child.stdout?.off("data", onLog);
      child.stderr?.off("data", onLog);
      child.off("exit", onExit);
    }
  });
}

let host: ChildProcess | undefined;

async function main() {
  if (await probe()) {
    if (!RESTART) {
      log(`already listening at ${BRIDGE_URL} ✅  (pass --restart to force a fresh host)`);
      return;
    }
    log("restart requested — bringing the existing host down…");
  }
  await killStale();

  log("building kernel…");
  await run(TSX, ["build.ts"]);

  log("starting extension host (extensions-cli run)…");
  host = spawn(EXTENSIONS_CLI, ["run"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  // tee the host's output through so the user sees the activation chain live
  host.stdout?.pipe(process.stdout);
  host.stderr?.pipe(process.stderr);
  host.once("error", (err) => { log(`failed to spawn host: ${err.message}`); process.exit(1); });

  // forward Ctrl-C to the host so it shuts down cleanly with us
  process.on("SIGINT", () => host?.kill("SIGTERM"));
  process.on("SIGTERM", () => host?.kill("SIGTERM"));

  await waitForBridge(host);
  log(`bridge listening at ${BRIDGE_URL} ✅  (Ctrl-C to stop)`);

  // stay foreground until the host exits; mirror its exit code
  const code: number = await new Promise((resolve) => host!.once("exit", (c) => resolve(c ?? 0)));
  process.exit(code);
}

main().catch((err) => {
  log(`✖ ${err instanceof Error ? err.message : String(err)}`);
  host?.kill("SIGTERM");
  process.exit(1);
});
