// Phase 3 (TASK-06) contract: Discord client (bot REST / webhook / gateway), polls,
// bilingual thread responder and the offline mock transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentMonitor, type AgentActivityEvent } from '../src/monitor/agent_monitor.ts';
import { loadConfig } from '../src/config/env.ts';
import {
  BotRestTransport,
  WebhookTransport,
  GatewayListener,
  GATEWAY_INTENTS,
  buildBilingualEmbed,
  createDiscordClient,
  LANGUAGE_TAGS,
  type WebSocketLike,
} from '../src/discord/discord_client.ts';
import { MockDiscordTransport } from '../src/discord/mock_discord.ts';
import { buildTopicPoll, collectPollResults, postTopicPoll, tallyVotes, POLL_EMOJIS } from '../src/discord/poll_handler.ts';
import { createThreadResponder, detectLanguage, type Annotator } from '../src/discord/thread_responder.ts';

const recordEvents = (monitor: AgentMonitor) => {
  const events: AgentActivityEvent[] = [];
  monitor.subscribe((e) => events.push(e));
  return events;
};

// ---------- embed formatting ----------

test('buildBilingualEmbed tags languages and includes original + cultural notes', () => {
  const embed = buildBilingualEmbed({
    original: 'お盆休みはいつですか？',
    originalLang: 'ja',
    translation: 'When is the Obon holiday?',
    targetLang: 'en',
    notes: ['Obon is a mid-August Buddhist festival honouring ancestors.'],
  });

  assert.equal(embed.title, `${LANGUAGE_TAGS.ja} → ${LANGUAGE_TAGS.en}`);
  assert.equal(embed.description, 'When is the Obon holiday?');
  assert.deepEqual(embed.fields?.map((f) => f.name), ['Original', 'Cultural context']);
  assert.match(embed.fields![1].value, /^• Obon/);
});

test('buildBilingualEmbed omits empty notes and truncates oversized fields', () => {
  const embed = buildBilingualEmbed({
    original: 'x'.repeat(2000),
    originalLang: 'en',
    translation: 'y',
    targetLang: 'hi',
    notes: [],
  });

  assert.deepEqual(embed.fields?.map((f) => f.name), ['Original']);
  assert.equal(embed.fields![0].value.length, 1024);
  assert.ok(embed.fields![0].value.endsWith('…'));
});

// ---------- language detection ----------

test('detectLanguage identifies Japanese, Hindi and English by dominant script', () => {
  assert.equal(detectLanguage('来週の勉強会に参加します'), 'ja');
  assert.equal(detectLanguage('カレーが好きです'), 'ja');
  assert.equal(detectLanguage('दिवाली की शुभकामनाएं'), 'hi');
  assert.equal(detectLanguage('See you at the meetup!'), 'en');
  assert.equal(detectLanguage('Happy お盆 everyone, see you after the holidays'), 'en');
});

// ---------- polls ----------

test('buildTopicPoll assigns keycap emojis and renders options', () => {
  const poll = buildTopicPoll({ question: 'Next study-session topic?', options: ['Agents', 'RAG', 'Evals'] });

  assert.deepEqual(poll.options.map((o) => o.emoji), POLL_EMOJIS.slice(0, 3));
  const embed = poll.message.embeds![0];
  assert.match(embed.title!, /Next study-session topic\?/);
  assert.match(embed.description!, /1️⃣ Agents\n2️⃣ RAG\n3️⃣ Evals/);
});

test('buildTopicPoll rejects fewer than 2 or more than 10 options', () => {
  assert.throws(() => buildTopicPoll({ question: 'q', options: ['only'] }), /2-10 options/);
  assert.throws(() => buildTopicPoll({ question: 'q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }), /2-10 options/);
});

test('tallyVotes excludes the bot seed reaction, sorts results and picks a winner', () => {
  const poll = buildTopicPoll({ question: 'q', options: ['A', 'B', 'C'] });
  const result = tallyVotes(poll, [
    { emoji: '1️⃣', count: 2, me: true },
    { emoji: '2️⃣', count: 4, me: true },
    { emoji: '3️⃣', count: 1, me: true },
    { emoji: '🔥', count: 9, me: false }, // not a poll option
  ]);

  assert.deepEqual(result.results.map((r) => [r.option, r.votes]), [['B', 3], ['A', 1], ['C', 0]]);
  assert.equal(result.winner, 'B');
  assert.equal(result.totalVotes, 4);
});

test('tallyVotes reports no winner on a tie or with zero votes', () => {
  const poll = buildTopicPoll({ question: 'q', options: ['A', 'B'] });
  assert.equal(tallyVotes(poll, [{ emoji: '1️⃣', count: 2, me: false }, { emoji: '2️⃣', count: 2, me: false }]).winner, null);
  assert.equal(tallyVotes(poll, []).winner, null);
});

test('postTopicPoll sends the poll, seeds reactions in order, and logs telemetry', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const poll = buildTopicPoll({ question: 'q', options: ['A', 'B'] });

  const posted = await postTopicPoll({ transport, monitor }, 'events', poll);

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].channelId, 'events');
  assert.equal(posted.messageId, transport.sent[0].id);
  assert.deepEqual(await transport.getReactions('events', posted.messageId), [
    { emoji: '1️⃣', count: 1, me: true },
    { emoji: '2️⃣', count: 1, me: true },
  ]);
  assert.deepEqual(events.map((e) => [e.agent, e.type]), [['Discord', 'tool_call'], ['Discord', 'tool_result']]);
});

test('collectPollResults tallies simulated community votes', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const poll = buildTopicPoll({ question: 'q', options: ['A', 'B'] });
  const posted = await postTopicPoll({ transport, monitor }, 'events', poll);

  transport.simulateVote('events', posted.messageId, '2️⃣', 3);
  transport.simulateVote('events', posted.messageId, '1️⃣', 1);

  const result = await collectPollResults({ transport, monitor }, posted);
  assert.equal(result.winner, 'B');
  assert.equal(result.totalVotes, 4);
});

// ---------- thread responder ----------

const annotateToEnglish: Annotator = async (_msg, lang) => ({
  translation: 'When is the Obon holiday?',
  targetLang: lang === 'en' ? 'ja' : 'en',
  notes: ['Obon is in mid-August.'],
});

test('thread responder opens a thread and posts a bilingual embed for a monitored channel', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const responder = createThreadResponder({ transport, monitor, channelIds: ['general'], annotate: annotateToEnglish });

  const msg = transport.simulateIncoming({ channelId: 'general', content: 'お盆休みはいつですか？' }, { dispatch: false });
  const reply = await responder.handle(msg);

  assert.ok(reply);
  assert.equal(transport.threads.length, 1);
  assert.equal(transport.threads[0].parentMessageId, msg.id);
  const threadPost = transport.sent.find((s) => s.channelId === reply.threadId)!;
  assert.equal(threadPost.message.embeds![0].title, `${LANGUAGE_TAGS.ja} → ${LANGUAGE_TAGS.en}`);
  assert.deepEqual(events.map((e) => e.type), ['thought', 'tool_call', 'tool_result']);
});

test('thread responder ignores bots, unmonitored channels and messages needing no annotation', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  let annotateCalls = 0;
  const responder = createThreadResponder({
    transport,
    monitor,
    channelIds: ['general'],
    annotate: async () => {
      annotateCalls++;
      return null;
    },
  });

  const opts = { dispatch: false };
  assert.equal(await responder.handle(transport.simulateIncoming({ channelId: 'general', content: 'hi', isBot: true }, opts)), null);
  assert.equal(await responder.handle(transport.simulateIncoming({ channelId: 'random', content: 'hi' }, opts)), null);
  assert.equal(await responder.handle(transport.simulateIncoming({ channelId: 'general', content: 'hi' }, opts)), null);

  assert.equal(annotateCalls, 1);
  assert.equal(transport.sent.length, 0);
});

test('thread responder logs an error instead of throwing when annotation fails', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const responder = createThreadResponder({
    transport,
    monitor,
    channelIds: ['general'],
    annotate: async () => {
      throw new Error('LLM unavailable');
    },
  });

  const reply = await responder.handle(transport.simulateIncoming({ channelId: 'general', content: 'नमस्ते' }, { dispatch: false }));
  assert.equal(reply, null);
  assert.equal(events.at(-1)?.type, 'error');
  assert.match(events.at(-1)!.summary, /LLM unavailable/);
});

test('thread responder start() listens to live messages and stop() unsubscribes', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const responder = createThreadResponder({ transport, monitor, channelIds: ['general'], annotate: annotateToEnglish });

  const stop = responder.start();
  transport.simulateIncoming({ channelId: 'general', content: 'お盆休みはいつですか？' });
  await transport.idle();
  assert.equal(transport.threads.length, 1);

  stop();
  assert.equal(transport.listenerCount(), 0);
});

// ---------- live transports (network faked) ----------

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift() ?? { status: 204 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { impl, calls };
}

test('BotRestTransport sends messages with bot auth and a reply reference', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { id: 'm1', channel_id: 'c1' } }]);
  const transport = new BotRestTransport({ token: 'tkn', fetch: impl });

  const sent = await transport.sendMessage('c1', { content: 'hello', replyTo: 'm0' });

  assert.deepEqual(sent, { id: 'm1', channelId: 'c1' });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/c1/messages');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bot tkn');
  assert.deepEqual(calls[0].body, { content: 'hello', message_reference: { message_id: 'm0' } });
});

test('BotRestTransport URL-encodes reaction emojis and maps reaction counts', async () => {
  const { impl, calls } = fakeFetch([
    { status: 204 },
    { status: 200, body: { id: 'm1', reactions: [{ emoji: { name: '1️⃣' }, count: 3, me: true }] } },
  ]);
  const transport = new BotRestTransport({ token: 'tkn', fetch: impl });

  await transport.addReaction('c1', 'm1', '1️⃣');
  const reactions = await transport.getReactions('c1', 'm1');

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `https://discord.com/api/v10/channels/c1/messages/m1/reactions/${encodeURIComponent('1️⃣')}/@me`);
  assert.deepEqual(reactions, [{ emoji: '1️⃣', count: 3, me: true }]);
});

test('BotRestTransport creates threads and retries after a 429 rate limit', async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: { retry_after: 0 } },
    { status: 201, body: { id: 't1' } },
  ]);
  const transport = new BotRestTransport({ token: 'tkn', fetch: impl });

  const thread = await transport.createThread('c1', 'm1', 'Translation');

  assert.deepEqual(thread, { id: 't1' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://discord.com/api/v10/channels/c1/messages/m1/threads');
  assert.equal((calls[1].body as { name: string }).name, 'Translation');
});

test('BotRestTransport surfaces non-retryable HTTP errors', async () => {
  const { impl } = fakeFetch([{ status: 403, body: { message: 'Missing Access' } }]);
  const transport = new BotRestTransport({ token: 'tkn', fetch: impl });
  await assert.rejects(transport.sendMessage('c1', { content: 'x' }), /403.*Missing Access/);
});

test('WebhookTransport posts with wait=true and rejects bot-only operations', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { id: 'm9', channel_id: 'c9' } }]);
  const transport = new WebhookTransport({ url: 'https://discord.com/api/webhooks/1/abc', fetch: impl });

  const sent = await transport.sendMessage('ignored', { content: 'hi' });

  assert.deepEqual(sent, { id: 'm9', channelId: 'c9' });
  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/1/abc?wait=true');
  await assert.rejects(transport.addReaction('c9', 'm9', '1️⃣'), /bot token/);
  await assert.rejects(transport.createThread('c9', 'm9', 't'), /bot token/);
});

class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  sent: unknown[] = [];
  closed = false;
  #listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  receive(payload: unknown) {
    for (const fn of this.#listeners.get('message') ?? []) fn({ data: JSON.stringify(payload) });
  }
}

test('GatewayListener identifies after HELLO and forwards human MESSAGE_CREATE events', () => {
  const received: string[] = [];
  const gateway = new GatewayListener({ token: 'tkn', WebSocket: FakeSocket, onMessage: (m) => received.push(m.content) });
  gateway.connect();
  const socket = FakeSocket.last;

  socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.deepEqual(socket.sent[0], {
    op: 2,
    d: { token: 'tkn', intents: GATEWAY_INTENTS, properties: { os: 'node', browser: 'community-agent', device: 'community-agent' } },
  });

  const author = { id: 'u1', username: 'aiko' };
  socket.receive({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: 'm1', channel_id: 'c1', content: 'こんにちは', author } });
  socket.receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm2', channel_id: 'c1', content: 'bot', author: { ...author, bot: true } } });
  socket.receive({ op: 0, t: 'TYPING_START', s: 3, d: {} });

  assert.deepEqual(received, ['こんにちは']);
  gateway.close();
  assert.equal(socket.closed, true);
});

test('GATEWAY_INTENTS covers guilds, messages, reactions and message content', () => {
  assert.equal(GATEWAY_INTENTS, (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15));
});

// ---------- client factory ----------

test('createDiscordClient picks mock, bot or webhook transport from config', () => {
  assert.equal(createDiscordClient(loadConfig({})).mode, 'mock');
  assert.equal(createDiscordClient(loadConfig({ DEMO_MODE: 'live', DISCORD_BOT_TOKEN: 't' })).mode, 'bot');
  assert.equal(createDiscordClient(loadConfig({ DEMO_MODE: 'live', DISCORD_WEBHOOK_URL: 'https://x' })).mode, 'webhook');
  assert.equal(createDiscordClient(loadConfig({ DEMO_MODE: 'live' })).mode, 'mock', 'no credentials falls back to mock');
});
