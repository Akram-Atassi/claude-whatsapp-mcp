/**
 * Group, community and broadcast actions.
 *
 * Kept out of whatsapp.ts so the connection/ingestion layer stays focused on
 * the socket lifecycle. Everything here assumes a live socket and goes through
 * whatsapp.ensureReady() so a half-dead connection fails fast with a readable
 * message instead of hanging.
 */
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  jidNormalizedUser,
  type BinaryNode,
  type GroupMetadata,
  type ParticipantAction,
} from "baileys";
import { AmbiguousTargetError, displayName, resolveTarget } from "./resolve.js";
import { store } from "./store.js";
import { log, whatsapp } from "./whatsapp.js";

// ---------------------------------------------------------------- guardrails
/** Hard ceiling on one broadcast. WhatsApp bans accounts for bulk sending. */
export const BROADCAST_MAX = 50;
export const BROADCAST_MIN_DELAY_MS = 3000;
export const BROADCAST_MAX_DELAY_MS = 8000;

// -------------------------------------------------------------- resolution
export interface Recipient {
  input: string;
  jid?: string;
  name?: string;
  isGroup?: boolean;
  error?: string;
}

/**
 * Resolve many free-text recipients at once, collecting failures instead of
 * throwing on the first one — a broadcast should report every bad entry in a
 * single round trip rather than one per call.
 */
export function resolveRecipients(inputs: string[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const raw of inputs) {
    const input = String(raw ?? "").trim();
    if (!input) continue;
    try {
      const jid = resolveTarget(input);
      const name = displayName(jid);
      const isGroup = jid.endsWith("@g.us");
      if (seen.has(jid)) {
        out.push({ input, jid, name, isGroup, error: "duplicate of an earlier entry — will be skipped" });
        continue;
      }
      seen.add(jid);
      out.push({ input, jid, name, isGroup });
    } catch (err) {
      const msg =
        err instanceof AmbiguousTargetError
          ? err.message.split("\n")[0] + " (pass a jid to disambiguate)"
          : err instanceof Error
            ? err.message
            : String(err);
      out.push({ input, error: msg });
    }
  }
  return out;
}

/** Resolve one input to a person's jid. Groups are rejected. */
export function resolveUserJid(input: string): string {
  const jid = resolveTarget(input);
  if (jid.endsWith("@g.us")) throw new Error(`"${input}" is a group — a person is required here.`);
  return jidNormalizedUser(jid);
}

/** Resolve one input to a group/community jid. People are rejected. */
export function resolveGroupJid(input: string): string {
  const jid = resolveTarget(input);
  if (!jid.endsWith("@g.us")) throw new Error(`"${input}" is not a group or community (${jid}).`);
  return jid;
}

/**
 * Ask WhatsApp which of these numbers actually have accounts. Never throws —
 * a number missing from the result map is "unknown", not "does not exist".
 */
export async function checkOnWhatsApp(jids: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (!jids.length) return map;
  try {
    const sock = await whatsapp.ensureReady();
    const res = await sock.onWhatsApp(...jids);
    for (const r of res ?? []) {
      if (r?.jid) map.set(jidNormalizedUser(r.jid), !!r.exists);
    }
  } catch (err) {
    log(`onWhatsApp lookup failed (continuing): ${String(err)}`);
  }
  return map;
}

// --------------------------------------------------------------- broadcast
export interface BroadcastResult {
  jid: string;
  name: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface BroadcastJob {
  id: string;
  message: string;
  startedAt: number;
  finishedAt?: number;
  total: number;
  results: BroadcastResult[];
  cancelled: boolean;
}

const jobs = new Map<string, BroadcastJob>();
let jobSeq = 0;

export function getBroadcastJob(id?: string): BroadcastJob | undefined {
  if (id) return jobs.get(id);
  // most recent
  let latest: BroadcastJob | undefined;
  for (const j of jobs.values()) if (!latest || j.startedAt > latest.startedAt) latest = j;
  return latest;
}

export function cancelBroadcast(id?: string): BroadcastJob | undefined {
  const job = getBroadcastJob(id);
  if (job && !job.finishedAt) job.cancelled = true;
  return job;
}

/**
 * Fan a message out to individual chats, one at a time with jittered pacing.
 *
 * Runs in the background and returns the job immediately: 50 recipients at
 * 3-8s apart takes minutes, far longer than an MCP request should be held
 * open. Progress is read back with broadcast_status.
 */
export function startBroadcast(
  targets: { jid: string; name: string }[],
  message: string,
  minDelayMs: number,
  maxDelayMs: number,
): BroadcastJob {
  const job: BroadcastJob = {
    id: `bc${++jobSeq}-${Date.now().toString(36)}`,
    message,
    startedAt: Date.now(),
    total: targets.length,
    results: [],
    cancelled: false,
  };
  jobs.set(job.id, job);

  void (async () => {
    for (let i = 0; i < targets.length; i++) {
      if (job.cancelled) break;
      const { jid, name } = targets[i]!;
      try {
        const id = await whatsapp.sendText(jid, message);
        job.results.push({ jid, name, ok: true, messageId: id });
      } catch (err) {
        job.results.push({ jid, name, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      if (i < targets.length - 1 && !job.cancelled) {
        const wait = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    job.finishedAt = Date.now();
    store.flush();
    log(`broadcast ${job.id} finished: ${job.results.filter((r) => r.ok).length}/${job.total} sent`);
  })();

  return job;
}

export function describeJob(job: BroadcastJob): string {
  const sent = job.results.filter((r) => r.ok);
  const failed = job.results.filter((r) => !r.ok);
  const state = job.finishedAt ? (job.cancelled ? "cancelled" : "finished") : job.cancelled ? "cancelling" : "in progress";
  const lines = [
    `broadcast ${job.id} — ${state}`,
    `progress: ${job.results.length}/${job.total} attempted, ${sent.length} sent, ${failed.length} failed`,
    `message: ${job.message.length > 120 ? job.message.slice(0, 120) + "…" : job.message}`,
  ];
  if (sent.length) lines.push(`\nsent to:\n${sent.map((r) => `  ✓ ${r.name}`).join("\n")}`);
  if (failed.length) lines.push(`\nfailed:\n${failed.map((r) => `  ✗ ${r.name} — ${r.error}`).join("\n")}`);
  if (!job.finishedAt) lines.push("\nStill running — call broadcast_status again in a minute.");
  return lines.join("\n");
}

// ------------------------------------------------------------------ groups
/** WhatsApp's participant-update status codes, as something a human can act on. */
const PARTICIPANT_STATUS: Record<string, string> = {
  "200": "ok",
  "207": "ok (partial)",
  "401": "has blocked you",
  "403": "privacy settings block being added directly — send them the invite link instead",
  "404": "not on WhatsApp",
  "406": "not allowed",
  "408": "recently left this group and cannot be re-added yet",
  "409": "already in the group",
  "500": "group is full",
};

export function describeParticipantResults(
  results: { status: string; jid: string | undefined }[],
  action: string,
): string {
  if (!results.length) return `No response from WhatsApp for the ${action}.`;
  return results
    .map((r) => {
      const who = r.jid ? displayName(r.jid) : "unknown";
      const meaning = PARTICIPANT_STATUS[r.status] ?? `status ${r.status}`;
      const mark = r.status === "200" || r.status === "207" ? "✓" : "✗";
      return `  ${mark} ${who} (${r.jid ?? "?"}) — ${meaning}`;
    })
    .join("\n");
}

export async function createGroup(subject: string, participantJids: string[]): Promise<GroupMetadata> {
  const sock = await whatsapp.ensureReady();
  const meta = await sock.groupCreate(subject, participantJids);
  store.upsertChat({ jid: meta.id, name: meta.subject, isGroup: true });
  store.flush();
  return meta;
}

export async function participantsUpdate(
  groupJid: string,
  jids: string[],
  action: ParticipantAction,
): Promise<{ status: string; jid: string | undefined }[]> {
  const sock = await whatsapp.ensureReady();
  return sock.groupParticipantsUpdate(groupJid, jids, action);
}

export async function updateGroup(
  groupJid: string,
  opts: {
    subject?: string;
    description?: string;
    whoCanMessage?: "everyone" | "admins";
    whoCanEdit?: "everyone" | "admins";
    memberAddMode?: "everyone" | "admins";
    joinApproval?: boolean;
  },
): Promise<string[]> {
  const sock = await whatsapp.ensureReady();
  const done: string[] = [];
  if (opts.subject !== undefined) {
    await sock.groupUpdateSubject(groupJid, opts.subject);
    store.upsertChat({ jid: groupJid, name: opts.subject, isGroup: true });
    done.push(`renamed to "${opts.subject}"`);
  }
  if (opts.description !== undefined) {
    await sock.groupUpdateDescription(groupJid, opts.description);
    done.push("description updated");
  }
  if (opts.whoCanMessage !== undefined) {
    await sock.groupSettingUpdate(groupJid, opts.whoCanMessage === "admins" ? "announcement" : "not_announcement");
    done.push(`only ${opts.whoCanMessage} can send messages`);
  }
  if (opts.whoCanEdit !== undefined) {
    await sock.groupSettingUpdate(groupJid, opts.whoCanEdit === "admins" ? "locked" : "unlocked");
    done.push(`only ${opts.whoCanEdit} can edit group info`);
  }
  if (opts.memberAddMode !== undefined) {
    await sock.groupMemberAddMode(groupJid, opts.memberAddMode === "admins" ? "admin_add" : "all_member_add");
    done.push(`only ${opts.memberAddMode} can add participants`);
  }
  if (opts.joinApproval !== undefined) {
    await sock.groupJoinApprovalMode(groupJid, opts.joinApproval ? "on" : "off");
    done.push(`join approval ${opts.joinApproval ? "on" : "off"}`);
  }
  store.flush();
  return done;
}

export async function inviteLink(groupJid: string, revoke = false): Promise<string> {
  const sock = await whatsapp.ensureReady();
  const code = revoke ? await sock.groupRevokeInvite(groupJid) : await sock.groupInviteCode(groupJid);
  if (!code) throw new Error("WhatsApp did not return an invite code — you probably are not an admin of this group.");
  return `https://chat.whatsapp.com/${code}`;
}

export async function leaveGroup(groupJid: string): Promise<void> {
  const sock = await whatsapp.ensureReady();
  await sock.groupLeave(groupJid);
  store.flush();
}

// -------------------------------------------------------------- communities
export async function createCommunity(subject: string, description: string): Promise<GroupMetadata> {
  const sock = await whatsapp.ensureReady();
  const meta = await sock.communityCreate(subject, description);
  if (!meta) {
    throw new Error(
      "WhatsApp accepted the request but returned no community metadata. Check the WhatsApp app — it may have been created anyway.",
    );
  }
  store.upsertChat({ jid: meta.id, name: meta.subject, isGroup: true });
  store.flush();
  return meta;
}

export interface CommunityView {
  community: GroupMetadata;
  subgroups: GroupMetadata[];
}

/**
 * Communities and their linked groups, derived from the full participating
 * list. More reliable than the dedicated community query, which parses a
 * different node shape and comes back empty on some accounts.
 */
export async function listCommunities(): Promise<CommunityView[]> {
  const sock = await whatsapp.ensureReady();
  const all = await sock.groupFetchAllParticipating();
  const groups = Object.values(all) as GroupMetadata[];
  for (const g of groups) store.upsertChat({ jid: g.id, name: g.subject, isGroup: true });
  store.flush();

  const communities = groups.filter((g) => g.isCommunity);
  return communities.map((community) => ({
    community,
    subgroups: groups.filter((g) => g.linkedParent === community.id && g.id !== community.id),
  }));
}

/**
 * Link or unlink subgroups on a community.
 *
 * Baileys 6.7.24 has no helper for this, so it goes out as a raw w:g2 iq —
 * the same node WhatsApp Web sends.
 */
export async function linkSubgroups(
  communityJid: string,
  groupJids: string[],
  action: "link" | "unlink",
): Promise<Map<string, string>> {
  const sock = await whatsapp.ensureReady();

  const content: BinaryNode[] =
    action === "link"
      ? [
          {
            tag: "links",
            attrs: {},
            content: groupJids.map((jid) => ({
              tag: "link",
              attrs: { link_type: "sub_group" },
              content: [{ tag: "group", attrs: { jid } }],
            })),
          },
        ]
      : groupJids.map((jid) => ({
          tag: "unlink",
          attrs: { unlink_type: "sub_group" },
          content: [{ tag: "group", attrs: { jid } }],
        }));

  const result = (await sock.query({
    tag: "iq",
    attrs: { type: "set", xmlns: "w:g2", to: communityJid },
    content,
  })) as BinaryNode;

  const out = new Map<string, string>();
  const containers = action === "link" ? getBinaryNodeChildren(getBinaryNodeChild(result, "links"), "link") : getBinaryNodeChildren(result, "unlink");
  for (const node of containers) {
    const group = getBinaryNodeChild(node, "group");
    const jid = group?.attrs?.jid;
    if (!jid) continue;
    const err = getBinaryNodeChild(node, "error");
    out.set(
      String(jid),
      err ? `failed (${err.attrs?.code ?? "?"}${err.attrs?.text ? `: ${err.attrs.text}` : ""})` : action === "link" ? "linked" : "unlinked",
    );
  }
  // WhatsApp acks a fully successful request without echoing every child.
  for (const jid of groupJids) if (!out.has(jid)) out.set(jid, action === "link" ? "linked" : "unlinked");

  store.flush();
  return out;
}

export async function communityParticipantsUpdate(
  communityJid: string,
  jids: string[],
  action: ParticipantAction,
): Promise<{ status: string; jid: string | undefined }[]> {
  const sock = await whatsapp.ensureReady();
  return sock.communityParticipantsUpdate(communityJid, jids, action);
}

export function summariseGroup(meta: GroupMetadata): string {
  const admins = (meta.participants ?? []).filter((p) => p.admin).length;
  const bits = [
    `${meta.subject} — ${meta.id}`,
    meta.isCommunity ? "type: community" : meta.linkedParent ? `type: group in community ${displayName(meta.linkedParent)}` : "type: group",
    `${(meta.participants ?? []).length} participants (${admins} admin${admins === 1 ? "" : "s"})`,
  ];
  if (meta.desc) bits.push(`description: ${meta.desc}`);
  if (meta.announce) bits.push("only admins can send messages");
  if (meta.restrict) bits.push("only admins can edit group info");
  if (meta.joinApprovalMode) bits.push("join requests need approval");
  return bits.join("\n");
}
