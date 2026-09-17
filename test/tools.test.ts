/**
 * Exercises every declared tool over a real MCP client/server pair on an
 * in-memory transport, with a throwaway data directory and no WhatsApp
 * socket. Tools that only read the local store get seeded data and are
 * checked for real output; tools that need the live connection are checked
 * for a clean, non-throwing "not connected" error.
 *
 * Run with: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// The data dir is read from the environment when config.ts is first imported,
// so it has to be set before any dynamic import below.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-test-"));
process.env.WHATSAPP_MCP_DATA_DIR = dataDir;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { SERVER_INFO, SERVER_INSTRUCTIONS, TOOL_NAMES, registerTools } = await import("../src/tools.js");
const { store } = await import("../src/store.js");
const { whatsapp } = await import("../src/whatsapp.js");

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

const ALICE = "15551230001@s.whatsapp.net";
const BOB = "15551230002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

type CallResult = { content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>; isError?: boolean };

let client: InstanceType<typeof Client>;

function textOf(res: CallResult): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function call(name: (typeof TOOL_NAMES)[number], args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

/** Tools that need the socket must fail cleanly, not throw or hang. */
async function expectNotConnected(name: (typeof TOOL_NAMES)[number], args: Record<string, unknown> = {}) {
  const res = await call(name, args);
  assert.equal(res.isError, true, `${name} should report an error without a connection`);
  assert.match(textOf(res), /not connected|not linked/i, `${name}: ${textOf(res)}`);
}

before(async () => {
  // No socket is ever opened in tests. "waiting_for_qr_scan" makes every send
  // path fail immediately instead of waiting out the reconnect grace period.
  whatsapp.state = "waiting_for_qr_scan";
  store.load();
  store.setMe("15550000000@s.whatsapp.net", "Test Account");
  store.upsertContact({ jid: ALICE, name: "Alice Example" });
  store.upsertContact({ jid: BOB, name: "Bob Example" });
  store.upsertChat({ jid: ALICE, name: "Alice Example", isGroup: false, unread: 2, lastMessageTime: 1_700_000_100, lastMessagePreview: "see you tomorrow" });
  store.upsertChat({ jid: BOB, name: "Bob Example", isGroup: false, unread: 0, lastMessageTime: 1_700_000_000 });
  store.upsertChat({ jid: GROUP, name: "Weekend Plans", isGroup: true, unread: 0, lastMessageTime: 1_700_000_050 });
  store.addMessage({ id: "m1", chatJid: ALICE, fromMe: false, timestamp: 1_700_000_000, text: "hello there", senderJid: ALICE });
  store.addMessage({ id: "m2", chatJid: ALICE, fromMe: true, timestamp: 1_700_000_100, text: "see you tomorrow" });
  store.addMessage({ id: "m3", chatJid: GROUP, fromMe: false, timestamp: 1_700_000_050, text: "who is bringing snacks?", senderJid: BOB, senderName: "Bob Example" });
  store.addMessage({ id: "img1", chatJid: BOB, fromMe: false, timestamp: 1_700_000_010, text: "", mediaType: "image", mimetype: "image/jpeg", senderJid: BOB });

  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("tool registry", () => {
  it("declares exactly the expected tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    assert.equal(tools.length, 22);
  });

  it("sets all four annotation hints to explicit booleans on every tool", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      for (const hint of HINTS) {
        assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name}.${hint} must be a boolean`);
      }
      assert.ok(tool.description && tool.description.length > 10, `${tool.name} needs a description`);
      assert.ok(tool.title, `${tool.name} needs a title`);
    }
  });

  it("marks read-only tools as read-only and mutating tools as not", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations!]));
    for (const name of ["whatsapp_status", "list_chats", "search_contacts", "get_messages", "search_messages", "get_group_info", "list_communities"]) {
      assert.equal(byName.get(name)?.readOnlyHint, true, `${name} should be read-only`);
      assert.equal(byName.get(name)?.destructiveHint, false, `${name} should not be destructive`);
    }
    for (const name of ["send_message", "send_file", "broadcast_message", "create_group", "leave_group", "update_group", "manage_group_participants"]) {
      assert.equal(byName.get(name)?.readOnlyHint, false, `${name} should not be read-only`);
      assert.equal(byName.get(name)?.openWorldHint, true, `${name} talks to WhatsApp`);
    }
    for (const name of ["leave_group", "manage_group_participants", "update_group", "group_invite_link", "link_group_to_community"]) {
      assert.equal(byName.get(name)?.destructiveHint, true, `${name} should be flagged destructive`);
    }
  });
});

describe("local-store tools", () => {
  it("whatsapp_status reports state, account and counts", async () => {
    const out = textOf(await call("whatsapp_status"));
    assert.match(out, /state: /);
    assert.match(out, /Test Account 15550000000@s\.whatsapp\.net/);
    assert.match(out, /3 chats, 2 contacts, 4 messages/);
  });

  it("get_login_qr returns the pending QR as text and PNG", async () => {
    whatsapp.lastQr = "1@test-qr-payload,abc,def";
    const res = await call("get_login_qr");
    assert.notEqual(res.isError, true, textOf(res));
    assert.match(textOf(res), /Linked devices/);
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, "expected an image part");
    assert.equal(img.mimeType, "image/png");
    assert.ok(Buffer.from(img.data ?? "", "base64").subarray(1, 4).toString() === "PNG");
    whatsapp.lastQr = null;
  });

  it("list_chats lists, filters and sorts", async () => {
    const all = textOf(await call("list_chats"));
    assert.match(all, /3 of 3 chats/);
    assert.ok(all.indexOf("Alice Example") < all.indexOf("Weekend Plans"), "newest chat first");
    assert.match(all, /\[2 unread\]/);

    assert.match(textOf(await call("list_chats", { unread_only: true })), /1 of 1 chats/);
    assert.match(textOf(await call("list_chats", { groups_only: true })), /Weekend Plans \(group\)/);
    assert.match(textOf(await call("list_chats", { query: "bob" })), /Bob Example/);
    assert.match(textOf(await call("list_chats", { query: "nobody" })), /No chats match/);
  });

  it("search_contacts finds people and groups by name or number", async () => {
    assert.match(textOf(await call("search_contacts", { query: "alice" })), new RegExp(ALICE));
    assert.match(textOf(await call("search_contacts", { query: "weekend" })), /\(group\)/);
    assert.match(textOf(await call("search_contacts", { query: "5551230002" })), /Bob Example/);
    assert.match(textOf(await call("search_contacts", { query: "zzzz" })), /No contact or group/);
  });

  it("get_messages reads a chat, resolves names and pages with before", async () => {
    const out = textOf(await call("get_messages", { chat: "Alice" }));
    assert.match(out, /2 messages/);
    assert.match(out, /hello there/);
    assert.match(out, /You: see you tomorrow/);

    const older = textOf(await call("get_messages", { chat: ALICE, before: "1700000050" }));
    assert.match(older, /1 messages/);
    assert.doesNotMatch(older, /see you tomorrow/);

    const group = textOf(await call("get_messages", { chat: "Weekend Plans" }));
    assert.match(group, /Bob Example: who is bringing snacks\?/);

    const bad = await call("get_messages", { chat: ALICE, before: "not-a-date" });
    assert.equal(bad.isError, true);

    const unknown = await call("get_messages", { chat: "Nobody Here" });
    assert.equal(unknown.isError, true);
  });

  it("search_messages searches everywhere or in one chat", async () => {
    assert.match(textOf(await call("search_messages", { query: "snacks" })), /Weekend Plans/);
    assert.match(textOf(await call("search_messages", { query: "hello", chat: "Alice" })), /hello there/);
    assert.match(textOf(await call("search_messages", { query: "hello", chat: "Weekend Plans" })), /No messages containing/);
  });

  it("broadcast_message dry-runs without sending", async () => {
    const out = textOf(await call("broadcast_message", { recipients: ["Alice", "Bob Example", "Nobody"], message: "hi all" }));
    assert.match(out, /DRY RUN — nothing sent/);
    assert.match(out, /2 recipient\(s\)/);
    assert.match(out, /✗ Nobody/);
    assert.match(out, /confirm=true/);
  });

  it("broadcast_message refuses to confirm with unresolved recipients", async () => {
    const res = await call("broadcast_message", { recipients: ["Alice", "Nobody"], message: "hi", confirm: true });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Refusing to send/);
  });

  it("broadcast_status reports when nothing has run", async () => {
    assert.match(textOf(await call("broadcast_status")), /No broadcast has been started/);
    assert.match(textOf(await call("broadcast_status", { cancel: true })), /No broadcast/);
  });

  it("leave_group refuses without confirm", async () => {
    const res = await call("leave_group", { group: "Weekend Plans" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /confirm=true/);
  });

  it("update_group resolves the group before anything else", async () => {
    const res = await call("update_group", { group: "No Such Group", subject: "x" });
    assert.equal(res.isError, true);
    assert.doesNotMatch(textOf(res), /not linked/i, "an unknown group should fail on resolution, not on the connection");
  });

  it("download_media fails clearly for an unknown message id", async () => {
    const res = await call("download_media", { message_id: "does-not-exist" });
    assert.equal(res.isError, true);
  });
});

describe("tools that need the live connection fail cleanly when offline", () => {
  it("send_message", () => expectNotConnected("send_message", { to: "Alice", message: "hi" }));
  it("send_file", () => expectNotConnected("send_file", { to: "Alice", path: path.join(dataDir, "nope.png") }));
  it("download_media", async () => {
    // The stored message has no raw payload, so this fails on the media lookup
    // before any socket use; either way it must be a clean error.
    const res = await call("download_media", { message_id: "img1", chat: "Bob" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /no downloadable media|not linked|not connected/i);
  });
  it("get_group_info", () => expectNotConnected("get_group_info", { group: "Weekend Plans" }));
  it("mark_as_read", () => expectNotConnected("mark_as_read", { chat: "Alice" }));
  it("refresh_groups", () => expectNotConnected("refresh_groups"));
  it("broadcast_message with confirm", async () => {
    const res = await call("broadcast_message", { recipients: ["Alice"], message: "hi", confirm: true });
    // The job starts and its first send fails; the reply must still come back promptly.
    assert.match(textOf(res), /Job id:/);
    assert.match(textOf(await call("broadcast_status")), /failed|not linked|not connected/i);
  });
  it("create_group", () => expectNotConnected("create_group", { subject: "Test", participants: ["Alice"] }));
  it("manage_group_participants", () => expectNotConnected("manage_group_participants", { group: "Weekend Plans", participants: ["Alice"], action: "add" }));
  it("update_group", () => expectNotConnected("update_group", { group: "Weekend Plans", subject: "Renamed" }));
  it("group_invite_link", () => expectNotConnected("group_invite_link", { group: "Weekend Plans" }));
  it("leave_group with confirm", () => expectNotConnected("leave_group", { group: "Weekend Plans", confirm: true }));
  it("create_community", () => expectNotConnected("create_community", { subject: "Test Community" }));
  it("list_communities", () => expectNotConnected("list_communities"));
  it("link_group_to_community", () => expectNotConnected("link_group_to_community", { community: "Weekend Plans", groups: ["Weekend Plans"] }));
});

describe("input validation", () => {
  it("rejects a bad enum value before reaching the handler", async () => {
    const res = await call("manage_group_participants", { group: "Weekend Plans", participants: ["Alice"], action: "kick" });
    assert.equal(res.isError, true);
  });
  it("rejects an empty message", async () => {
    const res = await call("send_message", { to: "Alice", message: "" });
    assert.equal(res.isError, true);
  });
});
