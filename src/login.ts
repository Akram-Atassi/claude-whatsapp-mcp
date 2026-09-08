#!/usr/bin/env node
/**
 * Terminal helper: shows the QR code, waits for the phone to link, lets the
 * initial history sync land, then exits.
 *
 * Close this before starting Claude Desktop — only one process can hold the
 * WhatsApp session at a time.
 */
import qrcode from "qrcode-terminal";
import { AUTH_DIR, DATA_DIR } from "./config.js";
import { store } from "./store.js";
import { whatsapp } from "./whatsapp.js";

const IDLE_MS = 20_000;
const MAX_SYNC_MS = 6 * 60_000;

function line(msg: string) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  line(`WhatsApp MCP login`);
  line(`data dir: ${DATA_DIR}`);
  line(`auth dir: ${AUTH_DIR}\n`);

  await whatsapp.start();

  let shownQr: string | null = null;
  let connectedAt = 0;
  let lastCount = -1;
  let lastChange = Date.now();
  const started = Date.now();

  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));

    if (whatsapp.state === "logged_out") {
      line("\nThis device is logged out. Delete the data/auth folder and run npm run login again.");
      process.exit(1);
    }

    if (whatsapp.lastQr && whatsapp.lastQr !== shownQr) {
      shownQr = whatsapp.lastQr;
      line("\nScan this with WhatsApp > Settings > Linked devices > Link a device:\n");
      qrcode.generate(shownQr, { small: true });
    }

    if (whatsapp.state === "connected") {
      if (!connectedAt) {
        connectedAt = Date.now();
        const me = store.getMe();
        line(`\nLinked as ${me?.name ? me.name + " " : ""}${me?.jid ?? "?"}`);
        line("Downloading chat history — this can take a minute...\n");
      }

      const c = store.counts();
      if (c.messages !== lastCount) {
        lastCount = c.messages;
        lastChange = Date.now();
        process.stdout.write(`\r  ${c.chats} chats, ${c.contacts} contacts, ${c.messages} messages   `);
      }

      const idle = Date.now() - lastChange;
      if (connectedAt && idle > IDLE_MS && lastCount > 0) break;
      if (Date.now() - started > MAX_SYNC_MS) {
        line("\n\nStopping the sync wait (time limit). What arrived so far is saved.");
        break;
      }
    }
  }

  store.flush();
  const c = store.counts();
  line(`\n\nDone. Stored ${c.chats} chats, ${c.contacts} contacts, ${c.messages} messages.`);
  line("You can close this window and start Claude Desktop now.");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`login failed: ${String(err)}\n`);
  process.exit(1);
});
