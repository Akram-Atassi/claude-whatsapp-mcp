#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { store } from "./store.js";
import { callLeader, connectionLock, currentLeader, startLeaderServer, type LeaderServer } from "./lock.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS, registerTools } from "./tools.js";
import { log, whatsapp } from "./whatsapp.js";

const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

// ------------------------------------------- single-instance tool routing
//
// Claude Desktop starts this server twice. Only the instance holding the lock
// opens a WhatsApp socket; the others register the same tools but forward each
// call to the owner, so every surface keeps working with one Baileys client.

type ToolHandler = (args: any, extra?: any) => Promise<any>;

const toolHandlers = new Map<string, ToolHandler>();
let role: "leader" | "proxy" = "proxy";
let leaderServer: LeaderServer | null = null;

const rawRegisterTool = (server as any).registerTool.bind(server);
(server as any).registerTool = (name: string, meta: any, handler: ToolHandler) => {
  toolHandlers.set(name, handler);
  return rawRegisterTool(name, meta, (args: any, extra: any) => routeToolCall(name, args, extra));
};

// The tool definitions live in tools.ts; registering them here goes through
// the routing wrapper above.
registerTools(server);

/** Claims the WhatsApp connection if it is free, and starts it if we win. */
async function tryBecomeLeader(): Promise<boolean> {
  if (role === "leader") return true;
  if (currentLeader()) return false;

  let ipc: LeaderServer;
  try {
    ipc = await startLeaderServer(async (name, args) => {
      const handler = toolHandlers.get(name);
      if (!handler) throw new Error(`unknown tool: ${name}`);
      return handler(args, {});
    });
  } catch (err) {
    log(`could not open the local handoff port: ${String(err)}`);
    return false;
  }

  if (!(await connectionLock.acquire(ipc.port, ipc.token))) {
    ipc.close();
    return false;
  }

  leaderServer = ipc;
  role = "leader";
  log(`pid ${process.pid} owns the WhatsApp connection (handoff port ${ipc.port})`);
  whatsapp.start().catch((err) => log(`startup failed: ${String(err)}`));
  return true;
}

async function routeToolCall(name: string, args: any, extra: any): Promise<any> {
  const handler = toolHandlers.get(name);
  if (!handler) return fail(`unknown tool: ${name}`);
  if (role === "leader") return handler(args, extra);

  const leader = currentLeader();
  if (leader) {
    try {
      const reply = await callLeader(leader, name, args);
      if (reply.ok) return reply.result;
      return fail(String(reply.error ?? "the instance holding the connection reported an error"));
    } catch (err) {
      log(`handoff to pid ${leader.pid} failed (${String(err)}) — trying to take over`);
    }
  }

  // The owner is gone or unreachable, so take the connection over ourselves.
  if (await tryBecomeLeader()) return handler(args, extra);

  return fail(
    "Another copy of this server owns the WhatsApp connection and could not be reached. " +
      "Quit Claude Desktop from the tray, reopen it, and try again.",
  );
}

// ---------------------------------------------------------------- bootstrap
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio");

  if (!(await tryBecomeLeader())) {
    const leader = currentLeader();
    log(`pid ${leader?.pid ?? "?"} already owns the WhatsApp connection — this instance proxies to it`);
    // Take over if that instance ever goes away.
    const watch = setInterval(() => {
      if (role !== "leader" && !currentLeader()) void tryBecomeLeader();
    }, 10000);
    if (typeof watch.unref === "function") watch.unref();
  }

  const shutdown = () => {
    connectionLock.release();
    leaderServer?.close();
    store.flush();
    process.exit(0);
  };
  process.on("exit", () => connectionLock.release());
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("beforeExit", () => store.flush());
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
