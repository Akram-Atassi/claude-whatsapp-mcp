import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Diagnostics go to stderr (Claude Desktop captures that in its own log) and
 * are also appended to server.log in the data dir, which is much easier to
 * find when something goes wrong. Rotated at ~2 MB, one old copy kept.
 */
const LOG_FILE = path.join(DATA_DIR, "server.log");
const MAX_BYTES = 2_000_000;

export function writeLog(tag: string, msg: string): void {
  const line = `${new Date().toISOString()} [${tag}] pid=${process.pid} ${msg}\n`;
  process.stderr.write(`[${tag}] ${msg}\n`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* logging must never break the server */
  }
}
