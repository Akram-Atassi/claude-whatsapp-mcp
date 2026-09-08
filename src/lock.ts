import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DATA_DIR, ensureDirs } from "./config.js";

/**
 * Claude Desktop starts this server more than once (two child processes of the
 * same claude.exe, a couple of seconds apart). Two Baileys clients sharing one
 * credential set make WhatsApp drop the link with "Stream Errored (conflict)",
 * which costs a QR re-scan and a full history re-sync.
 *
 * So exactly one instance owns the WhatsApp socket. It records a lock in the
 * data dir along with a loopback port; every other instance stays a thin proxy
 * and forwards its tool calls there, so all instances keep serving tools while
 * only one talks to WhatsApp.
 */

const LOCK_FILE = path.join(DATA_DIR, "connection.lock");
const HEARTBEAT_MS = 4000;
/** A lock whose heartbeat is older than this is treated as abandoned. */
const STALE_MS = 15000;

export interface LockRecord {
  pid: number;
  port: number;
  token: string;
  heartbeat: number;
  startedAt: number;
}

function llog(msg: string): void {
  process.stderr.write(`[lock] ${msg}\n`);
}

function readLock(): LockRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (typeof rec?.pid !== "number") return null;
    return rec as LockRecord;
  } catch {
    return null;
  }
}

/** EPERM means the pid exists but belongs to someone else - still alive. */
function processAlive(pid: number): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** The live lock record, when another running instance holds it. */
export function currentLeader(): LockRecord | null {
  const rec = readLock();
  if (!rec || rec.pid === process.pid) return null;
  const fresh = Date.now() - (rec.heartbeat ?? 0) < STALE_MS;
  if (fresh && processAlive(rec.pid)) return rec;
  return null;
}

class ConnectionLock {
  held = false;
  private timer: NodeJS.Timeout | null = null;
  private record: LockRecord | null = null;

  private write(rec: LockRecord): void {
    const tmp = `${LOCK_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, LOCK_FILE);
  }

  /**
   * Claims ownership. Writes our record, then re-reads after a beat: if two
   * instances raced, the loser sees the winner's pid and backs off.
   */
  async acquire(port: number, token: string): Promise<boolean> {
    ensureDirs();
    if (currentLeader()) return false;

    const now = Date.now();
    const rec: LockRecord = { pid: process.pid, port, token, heartbeat: now, startedAt: now };
    try {
      this.write(rec);
    } catch (err) {
      llog(`could not write the lock file: ${String(err)}`);
      return false;
    }

    await new Promise((r) => setTimeout(r, 300));
    const back = readLock();
    if (!back || back.pid !== process.pid) {
      llog(`lost the race for the WhatsApp connection to pid ${back?.pid ?? "?"}`);
      return false;
    }

    this.record = rec;
    this.held = true;
    this.timer = setInterval(() => {
      if (!this.record) return;
      this.record.heartbeat = Date.now();
      try {
        this.write(this.record);
      } catch {
        /* a missed beat is fine; the next one refreshes it */
      }
    }, HEARTBEAT_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return true;
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    try {
      const rec = readLock();
      if (rec?.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {
      /* a stale file just ages out via the heartbeat check */
    }
  }
}

export const connectionLock = new ConnectionLock();

export type ToolInvoker = (name: string, args: unknown) => Promise<unknown>;

export interface LeaderServer {
  port: number;
  token: string;
  close(): void;
}

/** Loopback-only RPC endpoint the proxy instances call. */
export async function startLeaderServer(invoke: ToolInvoker): Promise<LeaderServer> {
  const token = crypto.randomBytes(24).toString("hex");

  const httpServer = http.createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/call") return reply(404, { ok: false, error: "not found" });
    if (req.headers["x-lock-token"] !== token) return reply(403, { ok: false, error: "bad token" });

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { name, args } = JSON.parse(body || "{}");
        const result = await invoke(String(name), args);
        reply(200, { ok: true, result });
      } catch (err: any) {
        reply(200, { ok: false, error: String(err?.message ?? err) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, token, close: () => httpServer.close() };
}

/** Forwards one tool call to the instance that owns the connection. */
export function callLeader(
  rec: LockRecord,
  name: string,
  args: unknown,
  timeoutMs = 180000,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const payload = JSON.stringify({ name, args });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: rec.port,
        path: "/call",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-lock-token": rec.token,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`unreadable reply from pid ${rec.pid}: ${String(err)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
