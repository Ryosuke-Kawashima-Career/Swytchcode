// Offline loopback Discord transport: instant, deterministic responses for judge demos.
import type {
  DiscordMessage,
  DiscordTransport,
  MessageListener,
  OutgoingMessage,
  ReactionCount,
  SentMessage,
} from './discord_client.ts';

export interface SentRecord extends SentMessage {
  message: OutgoingMessage;
}

export interface ThreadRecord {
  id: string;
  channelId: string;
  parentMessageId: string;
  name: string;
}

export class MockDiscordTransport implements DiscordTransport {
  readonly mode = 'mock';
  readonly sent: SentRecord[] = [];
  readonly threads: ThreadRecord[] = [];
  readonly #reactions = new Map<string, Map<string, { count: number; me: boolean }>>();
  readonly #listeners = new Set<MessageListener>();
  #pending: Promise<unknown>[] = [];
  #nextId = 1;

  #id(prefix: string) {
    return `${prefix}-${this.#nextId++}`;
  }

  #reactionsFor(channelId: string, messageId: string) {
    const key = `${channelId}/${messageId}`;
    if (!this.#reactions.has(key)) this.#reactions.set(key, new Map());
    return this.#reactions.get(key)!;
  }

  async sendMessage(channelId: string, message: OutgoingMessage): Promise<SentMessage> {
    const record = { id: this.#id('msg'), channelId, message };
    this.sent.push(record);
    return { id: record.id, channelId };
  }

  async createThread(channelId: string, messageId: string, name: string) {
    const thread = { id: this.#id('thread'), channelId, parentMessageId: messageId, name };
    this.threads.push(thread);
    return { id: thread.id };
  }

  async addReaction(channelId: string, messageId: string, emoji: string) {
    const reactions = this.#reactionsFor(channelId, messageId);
    const current = reactions.get(emoji) ?? { count: 0, me: false };
    if (!current.me) reactions.set(emoji, { count: current.count + 1, me: true });
  }

  async getReactions(channelId: string, messageId: string): Promise<ReactionCount[]> {
    return [...this.#reactionsFor(channelId, messageId)].map(([emoji, r]) => ({ emoji, ...r }));
  }

  onMessage(listener: MessageListener) {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  close() {
    this.#listeners.clear();
  }

  // ---------- simulation helpers ----------

  /** Simulates a community member posting; dispatches to listeners unless `dispatch: false`. */
  simulateIncoming(partial: Partial<DiscordMessage> & { content: string }, { dispatch = true } = {}): DiscordMessage {
    const message: DiscordMessage = {
      id: this.#id('in'),
      channelId: 'general',
      authorId: 'user-1',
      authorName: 'community-member',
      isBot: false,
      ...partial,
    };
    if (dispatch) {
      for (const listener of this.#listeners) this.#pending.push(Promise.resolve(listener(message)));
    }
    return message;
  }

  /** Simulates `count` community members reacting with `emoji`. */
  simulateVote(channelId: string, messageId: string, emoji: string, count = 1) {
    const reactions = this.#reactionsFor(channelId, messageId);
    const current = reactions.get(emoji) ?? { count: 0, me: false };
    reactions.set(emoji, { ...current, count: current.count + count });
  }

  /** Resolves once every dispatched listener has settled. */
  async idle() {
    const pending = this.#pending;
    this.#pending = [];
    await Promise.allSettled(pending);
  }

  listenerCount() {
    return this.#listeners.size;
  }
}
