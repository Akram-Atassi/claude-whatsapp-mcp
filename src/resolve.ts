import { store } from "./store.js";

export interface Candidate {
  jid: string;
  name: string;
  isGroup: boolean;
}

export function displayName(jid: string): string {
  const chat = store.getChat(jid);
  if (chat?.name) return chat.name;
  const contact = store.getContact(jid);
  if (contact?.name) return contact.name;
  if (contact?.notify) return contact.notify;
  const local = jid.split("@")[0];
  return jid.endsWith("@g.us") ? `Group ${local}` : `+${local}`;
}

function knownTargets(): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const chat of store.allChats()) {
    out.set(chat.jid, { jid: chat.jid, name: displayName(chat.jid), isGroup: chat.isGroup });
  }
  for (const contact of store.allContacts()) {
    if (out.has(contact.jid)) continue;
    out.set(contact.jid, { jid: contact.jid, name: displayName(contact.jid), isGroup: false });
  }
  return [...out.values()];
}

export class AmbiguousTargetError extends Error {
  constructor(public query: string, public candidates: Candidate[]) {
    super(
      `"${query}" matches ${candidates.length} chats. Be more specific or pass a jid:\n` +
        candidates
          .slice(0, 15)
          .map((c) => `  - ${c.name}${c.isGroup ? " (group)" : ""} — ${c.jid}`)
          .join("\n"),
    );
    this.name = "AmbiguousTargetError";
  }
}

/**
 * Turns a contact name, group name, phone number or raw jid into a jid.
 * Throws with the candidate list when a name is ambiguous.
 */
export function resolveTarget(query: string): string {
  const q = query.trim();
  if (!q) throw new Error("Empty chat/recipient.");

  // already a jid
  if (q.includes("@")) {
    if (q.endsWith("@g.us") || q.endsWith("@s.whatsapp.net") || q.endsWith("@lid")) return q;
    throw new Error(`Unrecognised jid: ${q}`);
  }

  const targets = knownTargets();
  const lower = q.toLowerCase();

  // exact name match
  const exact = targets.filter((t) => t.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0].jid;
  if (exact.length > 1) throw new AmbiguousTargetError(q, exact);

  // phone number
  const digits = q.replace(/[^0-9]/g, "");
  if (digits.length >= 7 && /^[+0-9()\s.-]+$/.test(q)) {
    const byNumber = targets.find((t) => t.jid.split("@")[0] === digits);
    return byNumber?.jid ?? `${digits}@s.whatsapp.net`;
  }

  // substring match
  const partial = targets.filter((t) => t.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0].jid;
  if (partial.length > 1) {
    partial.sort((a, b) => a.name.length - b.name.length);
    if (partial[0].name.length * 2 <= partial[1].name.length) return partial[0].jid;
    throw new AmbiguousTargetError(q, partial);
  }

  throw new Error(
    `No chat or contact matching "${q}". Try search_contacts first, or pass a phone number with country code.`,
  );
}

export function searchTargets(query: string, limit = 25): Candidate[] {
  const lower = query.trim().toLowerCase();
  const digits = query.replace(/[^0-9]/g, "");
  const scored = knownTargets()
    .map((t) => {
      const name = t.name.toLowerCase();
      let score = 0;
      if (!lower) score = 1;
      else if (name === lower) score = 100;
      else if (name.startsWith(lower)) score = 60;
      else if (name.includes(lower)) score = 40;
      if (digits.length >= 4 && t.jid.includes(digits)) score = Math.max(score, 50);
      return { t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return scored.slice(0, limit).map((s) => s.t);
}

export function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}
