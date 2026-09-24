// Bundles the server into two standalone files so it can run with nothing but
// Node installed — no node_modules needed at the destination.
import { build } from "esbuild";
import fs from "node:fs/promises";

/**
 * Baileys 6.7.24 reads the string attribute `offline` with plain truthiness,
 * so offline="0" (nothing pending) is treated as an offline backlog node. Those
 * go to a queue that never flushes the event buffer, and incoming messages stop
 * reaching messages.upsert while the socket looks healthy
 * (WhiskeySockets/Baileys#2810). Patched at bundle time so node_modules stays
 * pristine; the build fails if a Baileys upgrade moves the code.
 */
const isOffline = (expr) => `(!!${expr} && ${expr} !== '0')`;
const baileysPatches = [
  ["await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');", `await upsertMessage(msg, ${isOffline("node.attrs.offline")} ? 'append' : 'notify');`],
  ["offline: !!attrs.offline,", `offline: ${isOffline("attrs.offline")},`, 2],
  ["const isOffline = !!node.attrs.offline;", `const isOffline = ${isOffline("node.attrs.offline")};`],
];
const patchBaileys = {
  name: "patch-baileys-offline",
  setup(b) {
    b.onLoad({ filter: /baileys[\\/]lib[\\/]Socket[\\/]messages-recv\.js$/ }, async (args) => {
      let src = await fs.readFile(args.path, "utf8");
      for (const [from, to, times = 1] of baileysPatches) {
        const found = src.split(from).length - 1;
        if (found !== times) throw new Error(`baileys patch: expected ${times}x "${from}", found ${found}`);
        src = src.split(from).join(to);
      }
      return { contents: src, loader: "js" };
    });
  },
};

const common = {
  plugins: [patchBaileys],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  // ESM shims: some bundled CJS deps reference require/__dirname.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
};

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["src/login.ts"], outfile: "dist/login.js" });
console.log("bundled dist/index.js and dist/login.js");
