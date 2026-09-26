// Bilingual thread auto-responder: watches international channels and, when the
// annotator (Cultural Bridge agent) finds something worth explaining, replies in a thread.
import type { AgentMonitor } from '../monitor/agent_monitor.ts';
import { buildBilingualEmbed, truncate, type DiscordMessage, type DiscordTransport, type Lang } from './discord_client.ts';

export interface Annotation {
  translation: string;
  targetLang: Lang;
  notes: string[];
}

/** Returns null when the message needs no translation or cultural context. */
export type Annotator = (message: DiscordMessage, lang: Lang) => Promise<Annotation | null>;

export interface ThreadResponderOptions {
  transport: DiscordTransport;
  monitor: AgentMonitor;
  channelIds: string[];
  annotate: Annotator;
}

export interface ThreadReply {
  threadId: string;
  messageId: string;
}

/** Picks the language whose script has the most characters (Latin wins ties and empty input). */
export function detectLanguage(text: string): Lang {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  const ja = count(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
  const hi = count(/\p{Script=Devanagari}/gu);
  const en = count(/\p{Script=Latin}/gu);

  if (ja > en && ja >= hi) return 'ja';
  if (hi > en && hi > ja) return 'hi';
  return 'en';
}

export function createThreadResponder({ transport, monitor, channelIds, annotate }: ThreadResponderOptions) {
  const watched = new Set(channelIds);

  async function handle(message: DiscordMessage): Promise<ThreadReply | null> {
    // 1. Filter: humans only, in watched channels, with text.
    if (message.isBot || !watched.has(message.channelId) || !message.content.trim()) return null;

    try {
      // 2. Detect language and ask the annotator whether a bridge reply is needed.
      const lang = detectLanguage(message.content);
      monitor.logThought('Discord', `Detected ${lang} message from ${message.authorName}`, { messageId: message.id });
      const annotation = await annotate(message, lang);
      if (!annotation) return null;

      // 3. Open a thread on the original message and post the bilingual embed there.
      monitor.logToolCall('Discord', 'Opening bilingual thread reply', { messageId: message.id, targetLang: annotation.targetLang });
      const thread = await transport.createThread(message.channelId, message.id, `Bridge · ${truncate(message.content, 80)}`);
      const sent = await transport.sendMessage(thread.id, {
        embeds: [buildBilingualEmbed({ original: message.content, originalLang: lang, ...annotation })],
      });
      monitor.logToolResult('Discord', `Posted ${lang} → ${annotation.targetLang} thread reply`, { threadId: thread.id });

      return { threadId: thread.id, messageId: sent.id };
    } catch (error) {
      // A failed reply must never take down the channel listener.
      monitor.logError('Discord', `Thread reply failed: ${(error as Error).message}`, { messageId: message.id });
      return null;
    }
  }

  return {
    handle,
    /** Starts listening to live messages; returns a stop function. */
    start: () => transport.onMessage((message) => handle(message).then(() => {})),
  };
}
