import fs from "node:fs";
import { MAX_MESSAGES_PER_CHAT, STORE_FILE, ensureDirs } from "./config.js";

export interface StoredMessage {
  id: string;
  chatJid: string;
  senderJid?: string;
  senderName?: string;
  fromMe: boolean;
  /** unix seconds */
  timestamp: number;
  text: string;
  mediaType?: "image" | "video" | "audio" | "document" | "sticker";
  fileName?: string;
  mimetype?: string;
  isVoiceNote?: boolean;
  quotedId?: string;
  /** Full Baileys message, kept only for media so it can be downloaded later. */
  raw?: unknown;
}

export interface StoredChat {
  jid: string;
  name?: string;
  isGroup: boolean;
  unread: number;
  archived?: boolean;
  lastMessageTime?: number;
  lastMessagePreview?: string;
}

export interface StoredContact {
  jid: string;
  name?: string;
  notify?: string;
}

interface StoreShape {
  version: number;
  me?: { jid: string; name?: string };
  chats: Record<string, StoredChat>;
  contacts: Record<string, StoredContact>;
  messages: Record<string, StoredMessage[]>;
}

const EMPTY: StoreShape = { version: 1, chats: {}, contacts: {}, messages: {} };

export class Store {
  private data: StoreShape = structuredClone(EMPTY);
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  load(): void {
    ensureDirs();
    try {
      if (fs.existsSync(STORE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
        this.data = { ...structuredClone(EMPTY), ...parsed };
        for (const key of ["chats", "contacts", "messages"] as const) {
          if (!this.data[key]) (this.data as any)[key] = {};
        }
      }
    } catch (err) {
      process.stderr.write(`[store] could not read ${STORE_FILE}: ${String(err)}\n`);
      this.data = structuredClone(EMPTY);
    }
  }

  /** Marks the store dirty and schedules a write. */
  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  flush(): void {
    if (!this.dirty) return;
    ensureDirs();
    const tmp = `${STORE_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, STORE_FILE);
      this.dirty = false;
    } catch (err) {
      process.stderr.write(`[store] write failed: ${String(err)}\n`);
    }
  }

  // ---- identity -------------------------------------------------------

  setMe(jid: string, name?: string): void {
    this.data.me = { jid, name };
    this.touch();
  }
  getMe(): { jid: string; name?: string } | undefined {
    return this.data.me;
  }

  // ---- chats ----------------------------------------------------------

  upsertChat(chat: Partial<StoredChat> & { jid: string }): StoredChat {
    const existing = this.data.chats[chat.jid];
    const merged: StoredChat = {
      jid: chat.jid,
      isGroup: chat.isGroup ?? existing?.isGroup ?? chat.jid.endsWith("@g.us"),
      name: chat.name ?? existing?.name,
      unread: chat.unread ?? existing?.unread ?? 0,
      archived: chat.archived ?? existing?.archived,
      lastMessageTime: Math.max(chat.lastMessageTime ?? 0, existing?.lastMessageTime ?? 0) || undefined,
      lastMessagePreview: chat.lastMessagePreview ?? existing?.lastMessagePreview,
    };
    this.data.chats[chat.jid] = merged;
    this.touch();
    return merged;
  }

  getChat(jid: string): StoredChat | undefined {
    return this.data.chats[jid];
  }

  allChats(): StoredChat[] {
    return Object.values(this.data.chats);
  }

  setUnread(jid: string, unread: number): void {
    const chat = this.data.chats[jid];
    if (chat) {
      chat.unread = unread;
      this.touch();
    }
  }

  // ---- contacts -------------------------------------------------------

  upsertContact(contact: StoredContact): void {
    const existing = this.data.contacts[contact.jid];
    this.data.contacts[contact.jid] = {
      jid: contact.jid,
      name: contact.name ?? existing?.name,
      notify: contact.notify ?? existing?.notify,
    };
    this.touch();
  }

  getContact(jid: string): StoredContact | undefined {
    return this.data.contacts[jid];
  }

  allContacts(): StoredContact[] {
    return Object.values(this.data.contacts);
  }

  // ---- messages -------------------------------------------------------

  addMessage(msg: StoredMessage): void {
    const list = (this.data.messages[msg.chatJid] ??= []);
    const idx = list.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...msg };
    } else {
      list.push(msg);
      list.sort((a, b) => a.timestamp - b.timestamp);
      if (list.length > MAX_MESSAGES_PER_CHAT) {
        list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
      }
    }
    this.touch();
  }

  getMessages(chatJid: string): StoredMessage[] {
    return this.data.messages[chatJid] ?? [];
  }

  findMessage(id: string, chatJid?: string): StoredMessage | undefined {
    if (chatJid) return this.getMessages(chatJid).find((m) => m.id === id);
    for (const list of Object.values(this.data.messages)) {
      const hit = list.find((m) => m.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  allMessages(): StoredMessage[] {
    return Object.values(this.data.messages).flat();
  }

  counts(): { chats: number; contacts: number; messages: number } {
    return {
      chats: Object.keys(this.data.chats).length,
      contacts: Object.keys(this.data.contacts).length,
      messages: Object.values(this.data.messages).reduce((n, l) => n + l.length, 0),
    };
  }
}

export const store = new Store();
