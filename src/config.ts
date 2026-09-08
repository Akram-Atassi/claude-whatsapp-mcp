import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (dist/.. when compiled). */
export const PROJECT_ROOT = path.resolve(here, "..");

export const DATA_DIR = process.env.WHATSAPP_MCP_DATA_DIR
  ? path.resolve(process.env.WHATSAPP_MCP_DATA_DIR)
  : path.join(PROJECT_ROOT, "data");

export const AUTH_DIR = path.join(DATA_DIR, "auth");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const STORE_FILE = path.join(DATA_DIR, "store.json");

/** Messages kept per chat before the oldest are dropped. */
export const MAX_MESSAGES_PER_CHAT = 2000;

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, AUTH_DIR, MEDIA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
