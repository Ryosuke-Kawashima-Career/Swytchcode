// Discord client (TASK-06 / REQ-05): one transport interface with three backends.
//   - BotRestTransport: Discord REST v10 via native fetch + Gateway listener (native WebSocket)
//   - WebhookTransport: send-only fallback when no bot token is configured
//   - MockDiscordTransport (mock_discord.ts): in-memory loopback for offline demos
import type { AppConfig } from '../config/env.ts';
import { MockDiscordTransport } from './mock_discord.ts';

export type Lang = 'ja' | 'hi' | 'en';

export const LANGUAGE_TAGS: Record<Lang, string> = {
  ja: '🇯🇵 日本語',
  hi: '🇮🇳 हिन्दी',
  en: '🌐 English',
};

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export interface OutgoingMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  /** Message ID to reply to. */
  replyTo?: string;
}

export interface SentMessage {
  id: string;
  channelId: string;
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  isBot: boolean;
}

export interface ReactionCount {
  emoji: string;
  count: number;
  /** True when the bot itself reacted (seed reaction on polls). */
  me: boolean;
}

export type MessageListener = (message: DiscordMessage) => void | Promise<void>;

export interface DiscordTransport {
  readonly mode: 'mock' | 'bot' | 'webhook';
  sendMessage(channelId: string, message: OutgoingMessage): Promise<SentMessage>;
  createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  getReactions(channelId: string, messageId: string): Promise<ReactionCount[]>;
  /** Subscribes to human messages; returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void;
  close(): void;
}

// ---------- embed formatting ----------

export const EMBED_COLOR = 0x5865f2;
const FIELD_LIMIT = 1024;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface BilingualEmbedInput {
  original: string;
  originalLang: Lang;
  translation: string;
  targetLang: Lang;
  notes: string[];
}

export function buildBilingualEmbed(input: BilingualEmbedInput): DiscordEmbed {
  const fields = [{ name: 'Original', value: truncate(input.original, FIELD_LIMIT) }];
  if (input.notes.length > 0) {
    fields.push({ name: 'Cultural context', value: truncate(input.notes.map((n) => `• ${n}`).join('\n'), FIELD_LIMIT) });
  }
  return {
    title: `${LANGUAGE_TAGS[input.originalLang]} → ${LANGUAGE_TAGS[input.targetLang]}`,
    description: truncate(input.translation, 4096),
    color: EMBED_COLOR,
    fields,
    footer: { text: 'AI Community Organizer · Cultural Bridge' },
  };
}

// ---------- HTTP helper ----------

const API_BASE = 'https://discord.com/api/v10';
const MAX_RETRIES = 3;

async function discordRequest(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Rate limited: wait the server-provided retry_after (seconds) and try again.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const { retry_after = 1 } = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, retry_after * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${method} ${url} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  }
}

function toWireMessage({ content, embeds, replyTo }: OutgoingMessage) {
  return {
    ...(content !== undefined && { content }),
    ...(embeds && { embeds }),
    ...(replyTo && { message_reference: { message_id: replyTo } }),
  };
}

// ---------- bot transport (REST + gateway) ----------

export interface BotTransportOptions {
  token: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
}

export class BotRestTransport implements DiscordTransport {
  readonly mode = 'bot';
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #WebSocket?: WebSocketCtor;
  readonly #listeners = new Set<MessageListener>();
  #gateway?: GatewayListener;

  constructor({ token, fetch: fetchImpl = fetch, WebSocket }: BotTransportOptions) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#WebSocket = WebSocket;
  }

  #request(method: string, path: string, body?: unknown) {
    return discordRequest(this.#fetch, `${API_BASE}${path}`, method, { Authorization: `Bot ${this.#token}` }, body);
  }

  async sendMessage(channelId: string, message: OutgoingMessage): Promise<SentMessage> {
    const res = await this.#request('POST', `/channels/${channelId}/messages`, toWireMessage(message));
    return { id: res.id, channelId: res.channel_id };
  }

  async createThread(channelId: string, messageId: string, name: string) {
    const res = await this.#request('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
      name: truncate(name, 100),
      auto_archive_duration: 1440,
    });
    return { id: res.id as string };
  }

  async addReaction(channelId: string, messageId: string, emoji: string) {
    await this.#request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async getReactions(channelId: string, messageId: string): Promise<ReactionCount[]> {
    const res = await this.#request('GET', `/channels/${channelId}/messages/${messageId}`);
    return (res.reactions ?? []).map((r: { emoji: { name: string }; count: number; me: boolean }) => ({
      emoji: r.emoji.name,
      count: r.count,
      me: r.me,
    }));
  }

  onMessage(listener: MessageListener) {
    // Connect to the gateway lazily, on the first subscriber.
    this.#listeners.add(listener);
    if (!this.#gateway) {
      this.#gateway = new GatewayListener({
        token: this.#token,
        WebSocket: this.#WebSocket,
        onMessage: (m) => this.#listeners.forEach((fn) => void fn(m)),
      });
      this.#gateway.connect();
    }
    return () => void this.#listeners.delete(listener);
  }

  close() {
    this.#gateway?.close();
    this.#gateway = undefined;
  }
}

// ---------- webhook transport (send-only) ----------

export class WebhookTransport implements DiscordTransport {
  readonly mode = 'webhook';
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor({ url, fetch: fetchImpl = fetch }: { url: string; fetch?: typeof fetch }) {
    this.#url = url;
    this.#fetch = fetchImpl;
  }

  /** Webhooks are bound to one channel, so `channelId` is ignored. */
  async sendMessage(_channelId: string, message: OutgoingMessage): Promise<SentMessage> {
    const res = await discordRequest(this.#fetch, `${this.#url}?wait=true`, 'POST', {}, toWireMessage(message));
    return { id: res.id, channelId: res.channel_id };
  }

  async createThread(_channelId: string, _messageId: string, _name: string): Promise<{ id: string }> {
    throw new Error('Threads require a bot token (DISCORD_BOT_TOKEN); webhooks are send-only');
  }

  async addReaction(_channelId: string, _messageId: string, _emoji: string): Promise<void> {
    throw new Error('Reactions require a bot token (DISCORD_BOT_TOKEN); webhooks are send-only');
  }

  async getReactions(_channelId: string, _messageId: string): Promise<ReactionCount[]> {
    throw new Error('Reading reactions requires a bot token (DISCORD_BOT_TOKEN); webhooks are send-only');
  }

  onMessage() {
    return () => {}; // webhooks cannot receive messages
  }

  close() {}
}

// ---------- gateway listener ----------

/** GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT (privileged: enable in the Developer Portal). */
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15);
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

export interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface GatewayOptions {
  token: string;
  onMessage: (message: DiscordMessage) => void;
  WebSocket?: WebSocketCtor;
}

/** Minimal gateway client: HELLO -> IDENTIFY -> heartbeat, forwarding MESSAGE_CREATE. No resume/reconnect. */
export class GatewayListener {
  readonly #options: GatewayOptions;
  #socket?: WebSocketLike;
  #heartbeat?: ReturnType<typeof setInterval>;
  #seq: number | null = null;

  constructor(options: GatewayOptions) {
    this.#options = options;
  }

  connect() {
    const Ctor = this.#options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    this.#socket = new Ctor(GATEWAY_URL);
    this.#socket.addEventListener('message', (event) => this.#onPayload(JSON.parse(String(event.data))));
  }

  close() {
    clearInterval(this.#heartbeat);
    this.#socket?.close();
  }

  #send(payload: unknown) {
    this.#socket?.send(JSON.stringify(payload));
  }

  #onPayload({ op, d, s, t }: { op: number; d: any; s?: number | null; t?: string | null }) {
    if (s != null) this.#seq = s;

    switch (op) {
      case 10: // HELLO: start heartbeating, then identify
        this.#heartbeat = setInterval(() => this.#send({ op: 1, d: this.#seq }), d.heartbeat_interval);
        this.#send({
          op: 2,
          d: {
            token: this.#options.token,
            intents: GATEWAY_INTENTS,
            properties: { os: 'node', browser: 'community-agent', device: 'community-agent' },
          },
        });
        break;
      case 1: // server requested an immediate heartbeat
        this.#send({ op: 1, d: this.#seq });
        break;
      case 0: // DISPATCH
        if (t === 'MESSAGE_CREATE' && !d.author?.bot) {
          this.#options.onMessage({
            id: d.id,
            channelId: d.channel_id,
            authorId: d.author.id,
            authorName: d.author.username,
            content: d.content ?? '',
            isBot: false,
          });
        }
        break;
    }
  }
}

// ---------- factory ----------

export function createDiscordClient(
  config: AppConfig,
  deps: { fetch?: typeof fetch; WebSocket?: WebSocketCtor } = {},
): DiscordTransport {
  // Live mode prefers the full bot, then the send-only webhook; anything else runs the mock.
  if (config.demoMode === 'live') {
    const { DISCORD_BOT_TOKEN, DISCORD_WEBHOOK_URL } = config.env;
    if (DISCORD_BOT_TOKEN) return new BotRestTransport({ token: DISCORD_BOT_TOKEN, ...deps });
    if (DISCORD_WEBHOOK_URL) return new WebhookTransport({ url: DISCORD_WEBHOOK_URL, fetch: deps.fetch });
  }
  return new MockDiscordTransport();
}
