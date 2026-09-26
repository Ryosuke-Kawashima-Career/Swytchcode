// Phase 4 (TASK-02, TASK-03) contract: Cultural Bridge agent and Event Orchestrator agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentMonitor, type AgentActivityEvent } from '../src/monitor/agent_monitor.ts';
import { MockDiscordTransport } from '../src/discord/mock_discord.ts';
import type { DiscordMessage } from '../src/discord/discord_client.ts';
import { createThreadResponder } from '../src/discord/thread_responder.ts';
import {
  createBridgeAgent,
  createPhrasebookTranslator,
  recognizeEntities,
  targetLanguageFor,
  type Translator,
} from '../src/agents/bridge_agent.ts';
import {
  buildNotionEventPage,
  createEventAgent,
  formatDualTime,
  suggestTimeSlots,
} from '../src/agents/event_agent.ts';

const recordEvents = (monitor: AgentMonitor) => {
  const events: AgentActivityEvent[] = [];
  monitor.subscribe((e) => events.push(e));
  return events;
};

const message = (content: string): DiscordMessage => ({
  id: 'm1',
  channelId: 'general',
  authorId: 'u1',
  authorName: 'member',
  content,
  isBot: false,
});

// ---------- Cultural Bridge: entity recognition ----------

test('recognizeEntities finds festivals and holidays across scripts, in order of appearance', () => {
  const ids = recognizeEntities('After お盆 we could celebrate Diwali — दिवाली — before Golden Week').map((e) => e.id);
  assert.deepEqual(ids, ['obon', 'diwali', 'golden-week']);
});

test('recognizeEntities detects honorifics and time-zone mentions', () => {
  const ids = recognizeEntities('Tanaka-san and Sharma-ji will host at 7pm IST / 10:30pm JST').map((e) => e.id);
  assert.deepEqual(ids, ['honorific-san', 'honorific-ji', 'timezone-ist', 'timezone-jst']);
});

test('recognizeEntities is case-insensitive, deduplicates, and ignores substrings', () => {
  assert.deepEqual(recognizeEntities('HOLI! holi again').map((e) => e.id), ['holi']);
  assert.deepEqual(recognizeEntities('The whole team visited Hollywood'), []);
});

test('every entity has English and Japanese notes', () => {
  for (const entity of recognizeEntities('Diwali Holi お盆 Golden Week 花見 正月 Republic Day Tanaka-san Sharma-ji 先輩 IST JST')) {
    assert.ok(entity.note.en && entity.note.ja, `${entity.id} missing a note`);
  }
});

test('targetLanguageFor bridges Japanese/Hindi to English and English to Japanese', () => {
  assert.equal(targetLanguageFor('ja'), 'en');
  assert.equal(targetLanguageFor('hi'), 'en');
  assert.equal(targetLanguageFor('en'), 'ja');
});

// ---------- Cultural Bridge: translator ----------

test('phrasebook translator returns known translations and marks unknown text', async () => {
  const translate = createPhrasebookTranslator([{ ja: 'お盆休みはいつですか？', en: 'When is the Obon holiday?' }]);
  assert.equal(await translate(' お盆休みはいつですか？ ', 'ja', 'en'), 'When is the Obon holiday?');
  assert.equal(await translate('未知の文', 'ja', 'en'), '[ja→en machine translation unavailable offline] 未知の文');
});

// ---------- Cultural Bridge: annotator ----------

test('bridge annotator translates and attaches notes in the target language', async () => {
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const bridge = createBridgeAgent({
    monitor,
    translate: createPhrasebookTranslator([{ ja: 'お盆休みはいつですか？', en: 'When is the Obon holiday?' }]),
  });

  const annotation = await bridge.annotate(message('お盆休みはいつですか？'), 'ja');

  assert.ok(annotation);
  assert.equal(annotation.translation, 'When is the Obon holiday?');
  assert.equal(annotation.targetLang, 'en');
  assert.equal(annotation.notes.length, 1);
  assert.match(annotation.notes[0], /Obon/);
  assert.ok(events.every((e) => e.agent === 'Bridge'));
  assert.ok(events.some((e) => e.type === 'thought' && /Obon/.test(e.summary)));
});

test('bridge annotator gives Japanese readers Japanese notes for Indian culture', async () => {
  const bridge = createBridgeAgent({ monitor: new AgentMonitor(), translate: async (t) => `訳: ${t}` });
  const annotation = await bridge.annotate(message('Diwali meetup next week!'), 'en');

  assert.equal(annotation?.targetLang, 'ja');
  assert.match(annotation!.notes[0], /ディワリ/);
});

test('bridge annotator skips plain English with no cultural terms', async () => {
  let calls = 0;
  const translate: Translator = async (t) => (calls++, t);
  const bridge = createBridgeAgent({ monitor: new AgentMonitor(), translate });

  assert.equal(await bridge.annotate(message('See you at the meetup!'), 'en'), null);
  assert.equal(calls, 0);
});

test('bridge annotator plugs into the Discord thread responder end to end', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const bridge = createBridgeAgent({
    monitor,
    translate: createPhrasebookTranslator([{ hi: 'दिवाली की शुभकामनाएं', en: 'Happy Diwali' }]),
  });
  const responder = createThreadResponder({ transport, monitor, channelIds: ['general'], annotate: bridge.annotate });

  const reply = await responder.handle(transport.simulateIncoming({ content: 'दिवाली की शुभकामनाएं' }, { dispatch: false }));

  assert.ok(reply);
  const embed = transport.sent[0].message.embeds![0];
  assert.equal(embed.description, 'Happy Diwali');
  assert.match(embed.fields!.find((f) => f.name === 'Cultural context')!.value, /Diwali/);
});

// ---------- Event Orchestrator: time zones ----------

test('formatDualTime renders the same instant in IST and JST', () => {
  const dual = formatDualTime(new Date('2026-10-03T12:30:00Z'));
  assert.equal(dual.ist, 'Sat, Oct 3 · 18:00 IST');
  assert.equal(dual.jst, 'Sat, Oct 3 · 21:30 JST');
  assert.equal(dual.label, 'Sat, Oct 3 · 18:00 IST / 21:30 JST');
});

test('formatDualTime handles the date rolling over in Japan only', () => {
  const dual = formatDualTime(new Date('2026-10-03T16:00:00Z'));
  assert.equal(dual.ist, 'Sat, Oct 3 · 21:30 IST');
  assert.equal(dual.jst, 'Sun, Oct 4 · 01:00 JST');
});

test('suggestTimeSlots spreads slots across the window comfortable in both countries', () => {
  const slots = suggestTimeSlots('2026-10-03', { count: 3, durationMinutes: 60 });

  // Both sides between 09:00 and 22:00 local: starts run 03:30Z (09:00 IST) .. 12:00Z (21:00 JST).
  assert.deepEqual(slots.map((s) => s.utc), ['2026-10-03T03:30:00.000Z', '2026-10-03T08:00:00.000Z', '2026-10-03T12:00:00.000Z']);
  assert.equal(slots[2].label, 'Sat, Oct 3 · 17:30 IST / 21:00 JST');
});

test('suggestTimeSlots returns nothing when the windows cannot overlap', () => {
  assert.deepEqual(suggestTimeSlots('2026-10-03', { durationMinutes: 60, startHour: 20, endHour: 22 }), []);
});

// ---------- Event Orchestrator: Notion page ----------

test('buildNotionEventPage produces a notion.page.create body with bilingual details', () => {
  const slot = formatDualTime(new Date('2026-10-03T12:30:00Z'));
  const body = buildNotionEventPage({
    parentPageId: 'parent-123',
    topic: 'AI Agents',
    slot: { ...slot, utc: '2026-10-03T12:30:00.000Z' },
    results: [
      { option: 'AI Agents', emoji: '1️⃣', votes: 5 },
      { option: 'RAG', emoji: '2️⃣', votes: 2 },
    ],
  });

  assert.deepEqual(body.parent, { page_id: 'parent-123' });
  assert.equal(body.properties.title.title[0].text.content, 'Antigravity Fan Club: AI Agents / 勉強会');
  const text = JSON.stringify(body.children);
  for (const expected of ['18:00 IST', '21:30 JST', 'AI Agents — 5 votes', 'RAG — 2 votes', '2026-10-03T12:30:00.000Z']) {
    assert.ok(text.includes(expected), `page body missing "${expected}"`);
  }
  assert.ok(body.children.every((b: { object: string; type: string }) => b.object === 'block' && b.type));
});

// ---------- Event Orchestrator: full poll -> plan flow ----------

test('event agent posts topic and time polls, then plans the event from community votes', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const agent = createEventAgent({ transport, monitor, channelId: 'events', parentPageId: 'parent-123' });

  const polls = await agent.openPolls({ date: '2026-10-03', topics: ['AI Agents', 'RAG', 'Evals'] });
  assert.equal(transport.sent.length, 2, 'topic poll + time poll');

  transport.simulateVote('events', polls.topic.messageId, '2️⃣', 4); // RAG
  transport.simulateVote('events', polls.time.messageId, '3️⃣', 3); // latest slot

  const plan = await agent.planEvent(polls);

  assert.equal(plan.topic, 'RAG');
  assert.equal(plan.slot.utc, '2026-10-03T12:00:00.000Z');
  assert.equal(plan.notionPage.parent.page_id, 'parent-123');
  assert.match(plan.notionPage.properties.title.title[0].text.content, /RAG/);
  assert.ok(events.some((e) => e.agent === 'Event' && e.type === 'thought'));
  assert.equal(events.at(-1)?.agent, 'Event');
  assert.equal(events.at(-1)?.type, 'status');
});

test('event agent breaks ties by option order and says so', async () => {
  const transport = new MockDiscordTransport();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const agent = createEventAgent({ transport, monitor, channelId: 'events', parentPageId: 'p' });

  const polls = await agent.openPolls({ date: '2026-10-03', topics: ['AI Agents', 'RAG'] });
  const plan = await agent.planEvent(polls); // nobody voted

  assert.equal(plan.topic, 'AI Agents');
  assert.equal(plan.slot.utc, polls.slots[0].utc);
  assert.ok(events.some((e) => e.agent === 'Event' && /no clear winner/i.test(e.summary)));
});
