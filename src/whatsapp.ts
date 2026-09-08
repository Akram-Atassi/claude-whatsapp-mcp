import fs from "node:fs";
import path from "node:path";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
} from "baileys";
import { AUTH_DIR, MEDIA_DIR, ensureDirs } from "./config.js";
import { store, type StoredMessage } from "./store.js";

/**
 * Baileys expects a pino-shaped logger. Anything written to stdout would
 * corrupt the MCP JSON-RPC stream, so this one discards everything; our own
 * diagnostics go to stderr via log() below.
 */
const noop = () => {};
export const silentLogger: any = {
  level: "silent",
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child() {
    return silentLogger;
  },
};

export function log(msg: string): void {
  process.stderr.write(`[whatsapp] ${msg}\n`);
}

export type ConnState =
  | "starting"
  | "waiting_for_qr_scan"
  | "connecting"
  | "connected"
  | "logged_out"
  | "disconnected";

class WhatsAppClient {
  sock: WASocket | null = null;
  state: ConnState = "starting";
  lastQr: string | null = null;
  lastError: string | null = null;
  private starting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /** Resolves the first time the socket reaches "connected". */
  private readyResolvers: Array<() => void> = [];

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    ensureDirs();
    store.load();
    try {
      await this.connect();
    } finally {
      this.starting = false;
    }
  }

  private async connect(): Promise<void> {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    this.state = authState.creds.registered ? "connecting" : "waiting_for_qr_scan";

    // Never let the version lookup stall startup - Baileys falls back to its
    // bundled version when this is undefined.
    const version = await Promise.race([
      fetchLatestBaileysVersion().then((r) => r.version),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6000)),
    ]).catch(() => undefined);
    if (!version) log("using the bundled WhatsApp Web version (version lookup unavailable)");

    const sock = makeWASocket({
      version,
      logger: silentLogger,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, silentLogger),
      },
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        const found = key.id ? store.findMessage(key.id, key.remoteJid ?? undefined) : undefined;
        const raw = found?.raw as any;
        return raw?.message ?? undefined;
      },
    });

    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQr = qr;
        this.state = "waiting_for_qr_scan";
        log("QR code received — scan it with WhatsApp > Linked devices");
      }

      if (connection === "open") {
        this.lastQr = null;
        this.lastError = null;
        this.state = "connected";
        this.reconnectAttempts = 0;
        const me = sock.user;
        if (me?.id) store.setMe(jidNormalizedUser(me.id), me.name ?? undefined);
        log(`connected as ${me?.id ?? "unknown"}`);
        for (const resolve of this.readyResolvers.splice(0)) resolve();
        void this.refreshGroups().catch(() => {});
      }

      if (connection === "close") {
        const status = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        this.lastError = lastDisconnect?.error?.message ?? null;

        if (status === DisconnectReason.loggedOut) {
          this.state = "logged_out";
          log("logged out — delete data/auth and link the device again");
          return;
        }

        this.state = "disconnected";
        log(`connection closed (${status ?? "unknown"}) — reconnect attempt ${this.reconnectAttempts + 1}`);
        this.scheduleReconnect();
      }
    });

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, progress }) => {
      for (const chat of chats) this.ingestChat(chat);
      for (const contact of contacts) this.ingestContact(contact);
      for (const msg of messages) this.ingestMessage(msg, false);
      log(`history sync: +${chats.length} chats, +${contacts.length} contacts, +${messages.length} messages${
        progress != null ? ` (${progress}%)` : ""
      }`);
      store.flush();
    });

    sock.ev.on("chats.upsert", (chats) => chats.forEach((c) => this.ingestChat(c)));
    sock.ev.on("chats.update", (chats) => chats.forEach((c) => this.ingestChat(c as any)));
    sock.ev.on("contacts.upsert", (cs) => cs.forEach((c) => this.ingestContact(c)));
    sock.ev.on("contacts.update", (cs) => cs.forEach((c) => this.ingestContact(c as any)));

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const msg of messages) this.ingestMessage(msg, type === "notify");
    });

    sock.ev.on("groups.upsert", (groups) => {
      for (const g of groups) {
        store.upsertChat({ jid: g.id, name: g.subject, isGroup: true });
      }
    });
    sock.ev.on("groups.update", (groups) => {
      for (const g of groups) {
        if (g.id) store.upsertChat({ jid: g.id, name: g.subject ?? undefined, isGroup: true });
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // 3s, 6s, 12s ... capped at 5 minutes, so a long outage does not spin.
    const delay = Math.min(3000 * 2 ** this.reconnectAttempts, 300_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => log(`reconnect failed: ${String(err)}`));
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  waitUntilReady(timeoutMs = 20000): Promise<boolean> {
    if (this.state === "connected") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.state === "connected"), timeoutMs);
      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  requireSocket(): WASocket {
    if (!this.sock) {
      throw new Error(
        `WhatsApp is not connected yet (state: ${this.state}). Wait a few seconds and check whatsapp_status.`,
      );
    }
    if (this.state === "logged_out") {
      throw new Error("WhatsApp is logged out. Delete the data/auth folder and link the device again.");
    }
    return this.sock;
  }

  /**
   * Like requireSocket(), but waits out a transient reconnect instead of
   * handing back a socket whose stream is already dead. Every send path goes
   * through this so a dropped connection fails with a readable message in a
   * few seconds rather than hanging until the MCP client times out.
   */
  async ensureReady(timeoutMs = 15000): Promise<WASocket> {
    if (this.state === "logged_out") {
      throw new Error("WhatsApp is logged out. Delete the data/auth folder and link the device again.");
    }
    if (this.state === "waiting_for_qr_scan") {
      throw new Error("This device is not linked yet. Run get_login_qr and scan the code.");
    }
    if (this.state !== "connected") {
      const ok = await this.waitUntilReady(timeoutMs);
      if (!ok) {
        const seconds = Math.round(timeoutMs / 1000);
        const detail = this.lastError ? " (" + this.lastError + ")" : "";
        const conflict = (this.lastError ?? "").toLowerCase().includes("conflict");
        throw new Error(
          "WhatsApp is " + this.state + detail + " and did not reconnect within " + seconds + "s." +
            (conflict
              ? " A \"conflict\" means another process is holding the same WhatsApp session - close WhatsApp Web in your browser, and any 'npm run login' window, then try again."
              : " Check whatsapp_status in a moment."),
        );
      }
    }
    return this.requireSocket();
  }

  // ---- ingestion ------------------------------------------------------

  private ingestChat(chat: any): void {
    if (!chat?.id) return;
    const jid = String(chat.id);
    if (jid === "status@broadcast") return;
    store.upsertChat({
      jid,
      name: chat.name ?? chat.subject ?? undefined,
      isGroup: !!isJidGroup(jid),
      unread: typeof chat.unreadCount === "number" && chat.unreadCount >= 0 ? chat.unreadCount : undefined,
      archived: typeof chat.archived === "boolean" ? chat.archived : undefined,
      lastMessageTime: chat.conversationTimestamp ? Number(chat.conversationTimestamp) : undefined,
    });
  }

  private ingestContact(contact: any): void {
    if (!contact?.id) return;
    const jid = jidNormalizedUser(String(contact.id));
    if (!jid || jid === "status@broadcast") return;
    store.upsertContact({
      jid,
      name: contact.name ?? contact.verifiedName ?? undefined,
      notify: contact.notify ?? undefined,
    });
  }

  ingestMessage(msg: WAMessage, isLive: boolean): void {
    const chatJid = msg.key?.remoteJid;
    if (!chatJid || chatJid === "status@broadcast" || !msg.key?.id) return;
    if (!msg.message) return;

    const info = describeMessage(msg);
    const stored: StoredMessage = {
      id: msg.key.id,
      chatJid,
      senderJid: msg.key.participant ? jidNormalizedUser(msg.key.participant) : undefined,
      senderName: msg.pushName ?? undefined,
      fromMe: !!msg.key.fromMe,
      timestamp: Number(msg.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000),
      text: info.text,
      mediaType: info.mediaType,
      fileName: info.fileName,
      mimetype: info.mimetype,
      isVoiceNote: info.isVoiceNote,
      quotedId: info.quotedId,
      raw: info.mediaType ? (msg as unknown) : undefined,
    };
    store.addMessage(stored);

    const preview = stored.text || (stored.mediaType ? `[${stored.mediaType}]` : "");
    const chat = store.getChat(chatJid);
    store.upsertChat({
      jid: chatJid,
      isGroup: !!isJidGroup(chatJid),
      lastMessageTime: stored.timestamp,
      lastMessagePreview: preview.slice(0, 200),
      unread: isLive && !stored.fromMe ? (chat?.unread ?? 0) + 1 : undefined,
    });

    if (stored.senderJid && stored.senderName) {
      const known = store.getContact(stored.senderJid);
      if (!known?.name) store.upsertContact({ jid: stored.senderJid, notify: stored.senderName });
    }
    if (!isJidGroup(chatJid) && !stored.fromMe && msg.pushName) {
      const known = store.getContact(jidNormalizedUser(chatJid));
      if (!known?.name) store.upsertContact({ jid: jidNormalizedUser(chatJid), notify: msg.pushName });
    }
  }

  // ---- actions --------------------------------------------------------

  async refreshGroups(): Promise<number> {
    const sock = this.requireSocket();
    const groups = await sock.groupFetchAllParticipating();
    let n = 0;
    for (const [jid, meta] of Object.entries(groups)) {
      store.upsertChat({ jid, name: (meta as any).subject, isGroup: true });
      n++;
    }
    store.flush();
    return n;
  }

  async sendText(jid: string, text: string, quotedId?: string): Promise<string> {
    const sock = await this.ensureReady();
    const quoted = quotedId ? (store.findMessage(quotedId, jid)?.raw as WAMessage | undefined) : undefined;
    const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    if (sent) this.ingestMessage(sent, false);
    return sent?.key?.id ?? "";
  }

  async sendFile(
    jid: string,
    filePath: string,
    kind: "auto" | "image" | "video" | "audio" | "voice" | "document",
    caption?: string,
  ): Promise<string> {
    const sock = await this.ensureReady();
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);

    const ext = path.extname(abs).toLowerCase();
    let resolved = kind;
    if (kind === "auto") {
      if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) resolved = "image";
      else if ([".mp4", ".mov", ".mkv", ".webm", ".3gp"].includes(ext)) resolved = "video";
      else if ([".ogg", ".opus", ".mp3", ".m4a", ".wav", ".aac"].includes(ext)) resolved = "audio";
      else resolved = "document";
    }

    let content: AnyMessageContent;
    switch (resolved) {
      case "image":
        content = { image: { url: abs }, caption };
        break;
      case "video":
        content = { video: { url: abs }, caption };
        break;
      case "audio":
        content = { audio: { url: abs }, mimetype: ext === ".mp3" ? "audio/mpeg" : "audio/mp4" };
        break;
      case "voice":
        content = { audio: { url: abs }, mimetype: "audio/ogg; codecs=opus", ptt: true };
        break;
      default:
        content = {
          document: { url: abs },
          fileName: path.basename(abs),
          mimetype: guessMime(ext),
          caption,
        };
    }

    const sent = await sock.sendMessage(jid, content);
    if (sent) this.ingestMessage(sent, false);
    return sent?.key?.id ?? "";
  }

  async downloadMedia(messageId: string, chatJid?: string): Promise<{ filePath: string; mimetype?: string; bytes: number }> {
    const rec = store.findMessage(messageId, chatJid);
    if (!rec) throw new Error(`No stored message with id ${messageId}.`);
    if (!rec.mediaType || !rec.raw) throw new Error(`Message ${messageId} has no downloadable media.`);

    const sock = this.requireSocket();
    const buffer = (await downloadMediaMessage(
      rec.raw as WAMessage,
      "buffer",
      {},
      { logger: silentLogger, reuploadRequest: sock.updateMediaMessage },
    )) as Buffer;

    ensureDirs();
    const ext =
      rec.fileName && path.extname(rec.fileName)
        ? path.extname(rec.fileName)
        : extForMime(rec.mimetype, rec.mediaType);
    const safe = `${rec.chatJid.split("@")[0]}_${rec.id}`.replace(/[^A-Za-z0-9_.-]/g, "_");
    const filePath = path.join(MEDIA_DIR, `${safe}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return { filePath, mimetype: rec.mimetype, bytes: buffer.length };
  }

  async markRead(jid: string, count = 30): Promise<number> {
    const sock = this.requireSocket();
    const msgs = store.getMessages(jid).filter((m) => !m.fromMe).slice(-count);
    const keys = msgs
      .map((m) => {
        const raw = m.raw as WAMessage | undefined;
        return raw?.key ?? { remoteJid: m.chatJid, id: m.id, fromMe: false, participant: m.senderJid };
      })
      .filter(Boolean) as any[];
    if (keys.length) await sock.readMessages(keys);
    store.setUnread(jid, 0);
    store.flush();
    return keys.length;
  }
}

// ---- message helpers ---------------------------------------------------

export function describeMessage(msg: WAMessage): {
  text: string;
  mediaType?: StoredMessage["mediaType"];
  fileName?: string;
  mimetype?: string;
  isVoiceNote?: boolean;
  quotedId?: string;
} {
  let content: any = msg.message;
  // unwrap ephemeral / view-once / device-sent wrappers
  for (let i = 0; i < 4 && content; i++) {
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    else if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    else if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    else if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    else break;
  }
  if (!content) return { text: "" };

  const type = getContentType(content);
  const node: any = type ? (content as any)[type] : undefined;
  const contextInfo = node?.contextInfo ?? content.extendedTextMessage?.contextInfo;
  const quotedId = contextInfo?.stanzaId ?? undefined;

  switch (type) {
    case "conversation":
      return { text: String(content.conversation ?? ""), quotedId };
    case "extendedTextMessage":
      return { text: String(node?.text ?? ""), quotedId };
    case "imageMessage":
      return { text: String(node?.caption ?? ""), mediaType: "image", mimetype: node?.mimetype, quotedId };
    case "videoMessage":
      return { text: String(node?.caption ?? ""), mediaType: "video", mimetype: node?.mimetype, quotedId };
    case "audioMessage":
      return {
        text: "",
        mediaType: "audio",
        mimetype: node?.mimetype,
        isVoiceNote: !!node?.ptt,
        quotedId,
      };
    case "documentMessage":
      return {
        text: String(node?.caption ?? ""),
        mediaType: "document",
        fileName: node?.fileName ?? undefined,
        mimetype: node?.mimetype,
        quotedId,
      };
    case "stickerMessage":
      return { text: "", mediaType: "sticker", mimetype: node?.mimetype, quotedId };
    case "reactionMessage":
      return { text: `[reacted ${node?.text ?? ""}]`, quotedId: node?.key?.id };
    case "protocolMessage":
    case "senderKeyDistributionMessage":
      return { text: "" };
    default:
      return { text: node?.caption ?? node?.text ?? "", quotedId };
  }
}

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

function extForMime(mimetype: string | undefined, media: string): string {
  if (mimetype?.includes("jpeg")) return ".jpg";
  if (mimetype?.includes("png")) return ".png";
  if (mimetype?.includes("webp")) return ".webp";
  if (mimetype?.includes("mp4")) return media === "audio" ? ".m4a" : ".mp4";
  if (mimetype?.includes("ogg")) return ".ogg";
  if (mimetype?.includes("mpeg")) return ".mp3";
  if (mimetype?.includes("pdf")) return ".pdf";
  return media === "image" ? ".jpg" : media === "video" ? ".mp4" : ".bin";
}

export const whatsapp = new WhatsAppClient();
