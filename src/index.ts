#!/usr/bin/env node
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { z } from "zod";
import { DATA_DIR } from "./config.js";
import { AmbiguousTargetError, displayName, formatTimestamp, resolveTarget, searchTargets } from "./resolve.js";
import {
  BROADCAST_MAX,
  cancelBroadcast,
  createCommunity,
  createGroup,
  describeJob,
  describeParticipantResults,
  getBroadcastJob,
  inviteLink,
  leaveGroup,
  linkSubgroups,
  listCommunities,
  participantsUpdate,
  resolveGroupJid,
  resolveRecipients,
  resolveUserJid,
  startBroadcast,
  updateGroup,
  type Recipient,
} from "./actions.js";
import { store } from "./store.js";
import { callLeader, connectionLock, currentLeader, startLeaderServer, type LeaderServer } from "./lock.js";
import { log, whatsapp } from "./whatsapp.js";

const server = new McpServer(
  { name: "whatsapp", version: "1.0.0" },
  { instructions: "Read and send WhatsApp messages from the user's own linked account. Always confirm the recipient with the user before sending anything." },
);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

async function withTarget<T>(query: string, fn: (jid: string) => Promise<T> | T) {
  try {
    return await fn(resolveTarget(query));
  } catch (err) {
    if (err instanceof AmbiguousTargetError) throw err;
    throw err;
  }
}

function guard(fn: () => Promise<ReturnType<typeof text>>) {
  return fn().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}

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

// 1 ---------------------------------------------------------------- status
server.registerTool(
  "whatsapp_status",
  {
    title: "WhatsApp status",
    description:
      "Connection state of the linked WhatsApp account, the number it is linked to, and how many chats/contacts/messages are stored locally.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const c = store.counts();
      const me = store.getMe();
      const lines = [
        `state: ${whatsapp.state}`,
        `account: ${me ? `${me.name ? me.name + " " : ""}${me.jid}` : "not linked yet"}`,
        `stored: ${c.chats} chats, ${c.contacts} contacts, ${c.messages} messages`,
        `data dir: ${DATA_DIR}`,
      ];
      if (whatsapp.state === "waiting_for_qr_scan") lines.push("Run get_login_qr and scan the code in WhatsApp > Settings > Linked devices.");
      if (whatsapp.state === "logged_out") lines.push("The device was unlinked. Delete data/auth and link again.");
      if (whatsapp.lastError) lines.push(`last error: ${whatsapp.lastError}`);
      return text(lines.join("\n"));
    }),
);

// 2 --------------------------------------------------------------- login qr
server.registerTool(
  "get_login_qr",
  {
    title: "Get login QR",
    description:
      "Returns the QR code to link this device to a WhatsApp account. Only needed the first time, or after being logged out.",
    inputSchema: {},
  },
  async () => {
    try {
      if (whatsapp.state === "connected") return text("Already connected — no QR needed.");
      for (let i = 0; i < 40 && !whatsapp.lastQr; i++) await new Promise((r) => setTimeout(r, 1000));
      const qr = whatsapp.lastQr;
      if (!qr) return text(`No QR available (state: ${whatsapp.state}). Try again in a few seconds.`);

      const ascii = await new Promise<string>((resolve) => qrcode.generate(qr, { small: true }, resolve));
      const png = await QRCode.toBuffer(qr, {
        type: "png",
        width: 512,
        margin: 2,
        errorCorrectionLevel: "L",
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              "On your phone: WhatsApp > Settings > Linked devices > Link a device, then scan the code below.\n" +
              "It expires after about 20 seconds — call get_login_qr again for a fresh one.\n\n" +
              "```\n" + ascii + "\n```",
          },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// 3 -------------------------------------------------------------- list chats
server.registerTool(
  "list_chats",
  {
    title: "List chats",
    description: "Recent WhatsApp chats with unread counts and last message preview.",
    inputSchema: {
      query: z.string().optional().describe("Only chats whose name contains this text"),
      limit: z.number().int().min(1).max(200).default(25).describe("How many chats to return"),
      unread_only: z.boolean().default(false).describe("Only chats with unread messages"),
      groups_only: z.boolean().default(false).describe("Only group chats"),
      include_archived: z.boolean().default(false).describe("Include archived chats"),
    },
  },
  async ({ query, limit, unread_only, groups_only, include_archived }) =>
    guard(async () => {
      let chats = store.allChats();
      if (!include_archived) chats = chats.filter((c) => !c.archived);
      if (groups_only) chats = chats.filter((c) => c.isGroup);
      if (unread_only) chats = chats.filter((c) => (c.unread ?? 0) > 0);
      if (query) {
        const q = query.toLowerCase();
        chats = chats.filter((c) => displayName(c.jid).toLowerCase().includes(q));
      }
      chats.sort((a, b) => (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0));
      const rows = chats.slice(0, limit).map((c) => {
        const bits = [
          displayName(c.jid),
          c.isGroup ? "(group)" : "",
          (c.unread ?? 0) > 0 ? `[${c.unread} unread]` : "",
          c.lastMessageTime ? formatTimestamp(c.lastMessageTime) : "",
        ].filter(Boolean);
        return `${bits.join(" ")}\n    jid: ${c.jid}${c.lastMessagePreview ? `\n    last: ${c.lastMessagePreview}` : ""}`;
      });
      if (!rows.length) return text("No chats match. If the store looks empty, history sync may still be running — check whatsapp_status.");
      return text(`${rows.length} of ${chats.length} chats:\n\n${rows.join("\n\n")}`);
    }),
);

// 4 --------------------------------------------------------- search contacts
server.registerTool(
  "search_contacts",
  {
    title: "Search contacts",
    description: "Find people or groups by name or phone number.",
    inputSchema: {
      query: z.string().describe("Name fragment or phone digits"),
      limit: z.number().int().min(1).max(100).default(25),
    },
  },
  async ({ query, limit }) =>
    guard(async () => {
      const hits = searchTargets(query, limit);
      if (!hits.length) return text(`No contact or group matching "${query}".`);
      return text(hits.map((h) => `${h.name}${h.isGroup ? " (group)" : ""} — ${h.jid}`).join("\n"));
    }),
);

// 5 ------------------------------------------------------------ get messages
server.registerTool(
  "get_messages",
  {
    title: "Get messages",
    description:
      "Read messages from one chat, newest last. Page further back with `before` (a unix timestamp or ISO date).",
    inputSchema: {
      chat: z.string().describe("Contact name, group name, phone number, or jid"),
      limit: z.number().int().min(1).max(200).default(50),
      before: z.string().optional().describe("Only messages older than this ISO date or unix timestamp"),
    },
  },
  async ({ chat, limit, before }) =>
    guard(async () => {
      const jid = await withTarget(chat, (j) => j);
      let msgs = store.getMessages(jid);
      if (before) {
        const cutoff = /^\d+$/.test(before) ? Number(before) : Math.floor(new Date(before).getTime() / 1000);
        if (Number.isNaN(cutoff)) return fail(`Could not read "${before}" as a date.`);
        msgs = msgs.filter((m) => m.timestamp < cutoff);
      }
      const slice = msgs.slice(-limit);
      if (!slice.length) return text(`No stored messages in ${displayName(jid)} for that range.`);
      const isGroup = jid.endsWith("@g.us");
      const body = slice
        .map((m) => {
          const who = m.fromMe ? "You" : isGroup ? m.senderName ?? displayName(m.senderJid ?? jid) : displayName(jid);
          const media = m.mediaType ? ` [${m.isVoiceNote ? "voice note" : m.mediaType}${m.fileName ? `: ${m.fileName}` : ""}]` : "";
          return `${formatTimestamp(m.timestamp)}  ${who}:${media}${m.text ? ` ${m.text}` : ""}  (id: ${m.id})`;
        })
        .join("\n");
      return text(`${displayName(jid)} — ${slice.length} messages (${jid})\n\n${body}`);
    }),
);

// 6 --------------------------------------------------------- search messages
server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description: "Full-text search across stored messages in every chat, or in one chat.",
    inputSchema: {
      query: z.string().describe("Text to look for"),
      chat: z.string().optional().describe("Restrict to one chat"),
      limit: z.number().int().min(1).max(200).default(30),
    },
  },
  async ({ query, chat, limit }) =>
    guard(async () => {
      const q = query.toLowerCase();
      const jid = chat ? await withTarget(chat, (j) => j) : undefined;
      const pool = jid ? store.getMessages(jid) : store.allMessages();
      const hits = pool
        .filter((m) => m.text.toLowerCase().includes(q))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
      if (!hits.length) return text(`No messages containing "${query}".`);
      return text(
        hits
          .map((m) => {
            const who = m.fromMe ? "You" : m.senderName ?? displayName(m.senderJid ?? m.chatJid);
            return `${formatTimestamp(m.timestamp)}  ${displayName(m.chatJid)} — ${who}: ${m.text}  (id: ${m.id}, chat: ${m.chatJid})`;
          })
          .join("\n"),
      );
    }),
);

// 7 ------------------------------------------------------------ send message
server.registerTool(
  "send_message",
  {
    title: "Send WhatsApp message",
    description:
      "Send a text message. Confirm the recipient with the user before calling. Optionally reply to a specific message by id.",
    inputSchema: {
      to: z.string().describe("Contact name, group name, phone number with country code, or jid"),
      message: z.string().min(1).describe("Text to send"),
      reply_to: z.string().optional().describe("Message id to quote"),
    },
  },
  async ({ to, message, reply_to }) =>
    guard(async () => {
      const jid = await withTarget(to, (j) => j);
      const id = await whatsapp.sendText(jid, message, reply_to);
      store.flush();
      return text(`Sent to ${displayName(jid)} (${jid}). Message id: ${id}`);
    }),
);

// 8 --------------------------------------------------------------- send file
server.registerTool(
  "send_file",
  {
    title: "Send a file",
    description: "Send an image, video, audio file, voice note, or document from a local path.",
    inputSchema: {
      to: z.string().describe("Contact name, group name, phone number, or jid"),
      path: z.string().describe("Absolute path to the file on this computer"),
      kind: z.enum(["auto", "image", "video", "audio", "voice", "document"]).default("auto"),
      caption: z.string().optional(),
    },
  },
  async ({ to, path: filePath, kind, caption }) =>
    guard(async () => {
      const jid = await withTarget(to, (j) => j);
      const id = await whatsapp.sendFile(jid, filePath, kind, caption);
      store.flush();
      return text(`Sent ${filePath} to ${displayName(jid)} (${jid}). Message id: ${id}`);
    }),
);

// 9 ----------------------------------------------------------- download media
server.registerTool(
  "download_media",
  {
    title: "Download an attachment",
    description: "Download the media of a stored message to disk. Images are also returned inline.",
    inputSchema: {
      message_id: z.string().describe("Message id from get_messages / search_messages"),
      chat: z.string().optional().describe("Chat the message is in (speeds up lookup)"),
    },
  },
  async ({ message_id, chat }) => {
    try {
      const jid = chat ? resolveTarget(chat) : undefined;
      const res = await whatsapp.downloadMedia(message_id, jid);
      const content: any[] = [
        { type: "text", text: `Saved to ${res.filePath} (${res.bytes} bytes${res.mimetype ? `, ${res.mimetype}` : ""}).` },
      ];
      if (res.mimetype?.startsWith("image/") && res.bytes < 4_000_000) {
        content.push({
          type: "image",
          data: fs.readFileSync(res.filePath).toString("base64"),
          mimeType: res.mimetype.split(";")[0],
        });
      }
      return { content };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// 10 ------------------------------------------------------------ group info
server.registerTool(
  "get_group_info",
  {
    title: "Group info",
    description: "Subject, description and participant list of a WhatsApp group.",
    inputSchema: { group: z.string().describe("Group name or jid") },
  },
  async ({ group }) =>
    guard(async () => {
      const jid = await withTarget(group, (j) => j);
      if (!jid.endsWith("@g.us")) return fail(`${displayName(jid)} is not a group.`);
      const meta = await whatsapp.requireSocket().groupMetadata(jid);
      const people = (meta.participants ?? []).map((p: any) => {
        const role = p.admin ? ` (${p.admin})` : "";
        return `  - ${displayName(p.id)}${role} — ${p.id}`;
      });
      return text(
        [
          `${meta.subject} (${jid})`,
          meta.desc ? `\n${meta.desc}\n` : "",
          `${people.length} participants:`,
          people.join("\n"),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
);

// 11 ----------------------------------------------------------- mark as read
server.registerTool(
  "mark_as_read",
  {
    title: "Mark chat as read",
    description: "Send read receipts for a chat's recent incoming messages and clear its unread badge.",
    inputSchema: {
      chat: z.string().describe("Contact name, group name, or jid"),
      count: z.number().int().min(1).max(100).default(30),
    },
  },
  async ({ chat, count }) =>
    guard(async () => {
      const jid = await withTarget(chat, (j) => j);
      const n = await whatsapp.markRead(jid, count);
      return text(`Marked ${n} message(s) read in ${displayName(jid)}.`);
    }),
);

// 12 --------------------------------------------------------- refresh groups
server.registerTool(
  "refresh_groups",
  {
    title: "Refresh groups",
    description: "Re-fetch every group the account belongs to, filling in missing group names.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const n = await whatsapp.refreshGroups();
      return text(`Refreshed ${n} groups.`);
    }),
);

// 13 --------------------------------------------------------------- broadcast
server.registerTool(
  "broadcast_message",
  {
    title: "Broadcast a message",
    description:
      "Send the same message to many chats, one individual message each (what a WhatsApp Broadcast List does under the hood — recipients do not see each other). " +
      "Runs a DRY RUN by default: call it once to see exactly who would receive it, show that list to the user, and only call again with confirm=true after they approve. " +
      "Capped at " + BROADCAST_MAX + " recipients, paced a few seconds apart. Bulk messaging is how WhatsApp accounts get banned — never use this for people who did not ask to hear from the user.",
    inputSchema: {
      recipients: z.array(z.string()).min(1).describe("Contact names, group names, phone numbers, or jids"),
      message: z.string().min(1).describe("The text every recipient gets"),
      confirm: z.boolean().default(false).describe("false = dry run (default). true = actually send; only after the user has seen the recipient list and approved."),
      skip_unresolved: z.boolean().default(false).describe("Send to the recipients that did resolve instead of refusing the whole batch"),
      min_delay_seconds: z.number().min(2).max(120).default(3).describe("Shortest pause between sends"),
      max_delay_seconds: z.number().min(2).max(300).default(8).describe("Longest pause between sends"),
    },
  },
  async ({ recipients, message, confirm, skip_unresolved, min_delay_seconds, max_delay_seconds }) =>
    guard(async () => {
      const resolved = resolveRecipients(recipients);
      const good = resolved.filter((r): r is Recipient & { jid: string; name: string } => !!r.jid && !r.error);
      const bad = resolved.filter((r) => r.error);

      if (!good.length) {
        return fail(`None of the ${recipients.length} recipients could be resolved:\n${bad.map((b) => `  ✗ ${b.input} — ${b.error}`).join("\n")}`);
      }
      if (good.length > BROADCAST_MAX) {
        return fail(
          `${good.length} recipients exceeds the ${BROADCAST_MAX}-recipient cap for one broadcast. ` +
            "Split it into smaller batches, and leave time between them — WhatsApp bans accounts for bulk sending.",
        );
      }
      if (bad.length && !skip_unresolved && !confirm) {
        // fall through to the dry run so the user sees both lists
      }
      if (bad.length && !skip_unresolved && confirm) {
        return fail(
          `Refusing to send: ${bad.length} recipient(s) could not be resolved.\n${bad
            .map((b) => `  ✗ ${b.input} — ${b.error}`)
            .join("\n")}\n\nFix them, or pass skip_unresolved=true to send to the other ${good.length}.`,
        );
      }

      const minMs = Math.round(min_delay_seconds * 1000);
      const maxMs = Math.round(Math.max(max_delay_seconds, min_delay_seconds) * 1000);
      const estimate = Math.round(((minMs + maxMs) / 2) * Math.max(0, good.length - 1) / 1000);

      const roster = good.map((r) => `  → ${r.name}${r.isGroup ? " (group)" : ""} — ${r.jid}`).join("\n");
      const problems = bad.length ? `\n\nCould not resolve (${skip_unresolved ? "will be skipped" : "must be fixed first"}):\n${bad.map((b) => `  ✗ ${b.input} — ${b.error}`).join("\n")}` : "";

      if (!confirm) {
        return text(
          `DRY RUN — nothing sent.\n\n` +
            `${good.length} recipient(s), about ${estimate}s of paced sending:\n${roster}${problems}\n\n` +
            `Message:\n${message}\n\n` +
            `Show this list to the user. If they approve, call broadcast_message again with the same arguments plus confirm=true.`,
        );
      }

      const job = startBroadcast(
        good.map((r) => ({ jid: r.jid, name: r.name })),
        message,
        minMs,
        maxMs,
      );

      // Give the first few sends a chance to land so the reply is informative,
      // but return well before an MCP client would time out.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && !job.finishedAt) await new Promise((r) => setTimeout(r, 500));

      return text(`${describeJob(job)}\n\nJob id: ${job.id} — track it with broadcast_status.`);
    }),
);

// 14 -------------------------------------------------------- broadcast status
server.registerTool(
  "broadcast_status",
  {
    title: "Broadcast progress",
    description: "Progress and per-recipient results of a broadcast started with broadcast_message. Can also cancel one that is still running.",
    inputSchema: {
      job_id: z.string().optional().describe("Defaults to the most recent broadcast"),
      cancel: z.boolean().default(false).describe("Stop the broadcast after the message currently in flight"),
    },
  },
  async ({ job_id, cancel }) =>
    guard(async () => {
      const job = cancel ? cancelBroadcast(job_id) : getBroadcastJob(job_id);
      if (!job) return text("No broadcast has been started in this session.");
      return text(describeJob(job));
    }),
);

// 15 ------------------------------------------------------------ create group
server.registerTool(
  "create_group",
  {
    title: "Create a group",
    description:
      "Create a WhatsApp group with an initial set of people. Confirm the name and the member list with the user first. " +
      "Optionally create it directly inside a community.",
    inputSchema: {
      subject: z.string().min(1).max(100).describe("Group name"),
      participants: z.array(z.string()).min(1).describe("People to add — names, phone numbers with country code, or jids. You are always included as the creator."),
      description: z.string().optional().describe("Group description, set right after creation"),
      community: z.string().optional().describe("Community name or jid to add this group to as a subgroup"),
      announcement_only: z.boolean().default(false).describe("Only admins can send messages"),
    },
  },
  async ({ subject, participants, description, community, announcement_only }) =>
    guard(async () => {
      const jids: string[] = [];
      const problems: string[] = [];
      for (const p of participants) {
        try {
          jids.push(resolveUserJid(p));
        } catch (err) {
          problems.push(`  ✗ ${p} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (problems.length) return fail(`Could not resolve every participant:\n${problems.join("\n")}\n\nFix these, then try again.`);

      const communityJid = community ? resolveGroupJid(community) : undefined;
      const meta = await createGroup(subject, jids);
      const lines = [`Created "${meta.subject}" — ${meta.id}`, `${(meta.participants ?? []).length} participants.`];

      if (description !== undefined || announcement_only) {
        const done = await updateGroup(meta.id, {
          description,
          whoCanMessage: announcement_only ? "admins" : undefined,
        });
        if (done.length) lines.push(`Settings: ${done.join("; ")}.`);
      }
      if (communityJid) {
        const res = await linkSubgroups(communityJid, [meta.id], "link");
        lines.push(`Community ${displayName(communityJid)}: ${res.get(meta.id) ?? "unknown"}.`);
      }
      lines.push(`Invite link: ${await inviteLink(meta.id).catch(() => "(unavailable)")}`);
      return text(lines.join("\n"));
    }),
);

// 16 ----------------------------------------------------- group participants
server.registerTool(
  "manage_group_participants",
  {
    title: "Add / remove / promote group members",
    description:
      "Add people to a group, remove them, or change who is an admin. You must be an admin of the group. " +
      "A person whose privacy settings block being added returns status 403 — send them the invite link instead.",
    inputSchema: {
      group: z.string().describe("Group name or jid"),
      participants: z.array(z.string()).min(1).describe("People — names, phone numbers with country code, or jids"),
      action: z.enum(["add", "remove", "promote", "demote"]),
    },
  },
  async ({ group, participants, action }) =>
    guard(async () => {
      const groupJid = resolveGroupJid(group);
      const jids: string[] = [];
      const problems: string[] = [];
      for (const p of participants) {
        try {
          jids.push(resolveUserJid(p));
        } catch (err) {
          problems.push(`  ✗ ${p} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!jids.length) return fail(`No participant could be resolved:\n${problems.join("\n")}`);

      const results = await participantsUpdate(groupJid, jids, action);
      const head = `${action} on ${displayName(groupJid)} (${groupJid}):`;
      return text([head, describeParticipantResults(results, action), problems.length ? `\nNot attempted:\n${problems.join("\n")}` : ""].filter(Boolean).join("\n"));
    }),
);

// 17 ------------------------------------------------------------ update group
server.registerTool(
  "update_group",
  {
    title: "Update group settings",
    description: "Rename a group, change its description, or change who may post, edit info, add members, or join. Requires admin.",
    inputSchema: {
      group: z.string().describe("Group or community name or jid"),
      subject: z.string().max(100).optional().describe("New name"),
      description: z.string().optional().describe("New description (empty string clears it)"),
      who_can_message: z.enum(["everyone", "admins"]).optional(),
      who_can_edit_info: z.enum(["everyone", "admins"]).optional(),
      who_can_add_members: z.enum(["everyone", "admins"]).optional(),
      join_approval_required: z.boolean().optional(),
    },
  },
  async ({ group, subject, description, who_can_message, who_can_edit_info, who_can_add_members, join_approval_required }) =>
    guard(async () => {
      const jid = resolveGroupJid(group);
      const done = await updateGroup(jid, {
        subject,
        description,
        whoCanMessage: who_can_message,
        whoCanEdit: who_can_edit_info,
        memberAddMode: who_can_add_members,
        joinApproval: join_approval_required,
      });
      if (!done.length) return text("Nothing to change — pass at least one setting.");
      return text(`${displayName(jid)} (${jid}):\n${done.map((d) => `  ✓ ${d}`).join("\n")}`);
    }),
);

// 18 ------------------------------------------------------------ invite link
server.registerTool(
  "group_invite_link",
  {
    title: "Group invite link",
    description: "Get the join link for a group, or revoke the old one and issue a fresh link. Requires admin.",
    inputSchema: {
      group: z.string().describe("Group or community name or jid"),
      revoke: z.boolean().default(false).describe("Invalidate the current link and return a new one"),
    },
  },
  async ({ group, revoke }) =>
    guard(async () => {
      const jid = resolveGroupJid(group);
      const link = await inviteLink(jid, revoke);
      return text(`${displayName(jid)}${revoke ? " (old link revoked)" : ""}\n${link}`);
    }),
);

// 19 ------------------------------------------------------------- leave group
server.registerTool(
  "leave_group",
  {
    title: "Leave a group",
    description: "Leave a group or community. This cannot be undone without a fresh invite — always confirm with the user first.",
    inputSchema: {
      group: z.string().describe("Group or community name or jid"),
      confirm: z.boolean().default(false).describe("Must be true. Ask the user before setting it."),
    },
  },
  async ({ group, confirm }) =>
    guard(async () => {
      const jid = resolveGroupJid(group);
      if (!confirm) return fail(`Not leaving "${displayName(jid)}" (${jid}). Confirm with the user, then call again with confirm=true.`);
      await leaveGroup(jid);
      return text(`Left ${displayName(jid)} (${jid}).`);
    }),
);

// 20 -------------------------------------------------------- create community
server.registerTool(
  "create_community",
  {
    title: "Create a community",
    description:
      "Create a WhatsApp community — an umbrella that holds several groups, with an announcement channel every member sees. " +
      "Members are not added directly to a community; they join by being in one of its groups. Use link_group_to_community or create_group(community=...) next.",
    inputSchema: {
      subject: z.string().min(1).max(100).describe("Community name"),
      description: z.string().default("").describe("What the community is for — shown to people who join"),
      link_groups: z.array(z.string()).optional().describe("Existing groups to move into this community right away"),
    },
  },
  async ({ subject, description, link_groups }) =>
    guard(async () => {
      const meta = await createCommunity(subject, description);
      const lines = [`Created community "${meta.subject}" — ${meta.id}`];
      if (link_groups?.length) {
        const jids = link_groups.map((g) => resolveGroupJid(g));
        const res = await linkSubgroups(meta.id, jids, "link");
        lines.push("\nLinked groups:");
        for (const [jid, status] of res) lines.push(`  ${status === "linked" ? "✓" : "✗"} ${displayName(jid)} — ${status}`);
      }
      lines.push(`\nInvite link: ${await inviteLink(meta.id).catch(() => "(unavailable)")}`);
      return text(lines.join("\n"));
    }),
);

// 21 --------------------------------------------------------- list communities
server.registerTool(
  "list_communities",
  {
    title: "List communities",
    description: "Every community this account belongs to, with the groups linked inside each one.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const views = await listCommunities();
      if (!views.length) return text("This account is not in any communities.");
      return text(
        views
          .map(({ community, subgroups }) => {
            const subs = subgroups.length
              ? subgroups.map((g) => `    - ${g.subject} (${g.participants?.length ?? 0} members) — ${g.id}`).join("\n")
              : "    (no linked groups)";
            return `${community.subject} — ${community.id}\n  ${community.participants?.length ?? 0} members\n  groups:\n${subs}`;
          })
          .join("\n\n"),
      );
    }),
);

// 22 ------------------------------------------------- link groups to community
server.registerTool(
  "link_group_to_community",
  {
    title: "Link or unlink community groups",
    description: "Move existing groups into a community as subgroups, or remove them from it. You must be an admin of both the community and each group.",
    inputSchema: {
      community: z.string().describe("Community name or jid"),
      groups: z.array(z.string()).min(1).describe("Group names or jids"),
      action: z.enum(["link", "unlink"]).default("link"),
    },
  },
  async ({ community, groups, action }) =>
    guard(async () => {
      const communityJid = resolveGroupJid(community);
      const jids = groups.map((g) => resolveGroupJid(g));
      const res = await linkSubgroups(communityJid, jids, action);
      const rows = [...res].map(([jid, status]) => `  ${status.startsWith("failed") ? "✗" : "✓"} ${displayName(jid)} — ${status}`);
      return text(`${action === "link" ? "Linking to" : "Unlinking from"} ${displayName(communityJid)}:\n${rows.join("\n")}`);
    }),
);

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
