// Phase 5 (TASK-04) contract: Swytchcode tool execution, Growth agent (X + Resend),
// and the closed-loop orchestrator: Discord polls -> Notion page -> X post -> sponsor emails.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentMonitor, type AgentActivityEvent } from '../src/monitor/agent_monitor.ts';
import { loadConfig } from '../src/config/env.ts';
import { MockDiscordTransport } from '../src/discord/mock_discord.ts';
import { formatDualTime } from '../src/agents/event_agent.ts';
import {
  SwyCliExecutor,
  SwytchcodeError,
  callTool,
  createToolExecutor,
  type CliResult,
} from '../src/swytchcode/executor.ts';
import { MockToolExecutor, DEMO_SPONSORS } from '../src/swytchcode/mock_executor.ts';
import {
  buildSponsorEmail,
  buildTweet,
  createGrowthAgent,
  parseSponsorRows,
  tweetLength,
} from '../src/agents/growth_agent.ts';
import { createOrchestrator, settingsFromConfig } from '../src/agents/orchestrator.ts';

const recordEvents = (monitor: AgentMonitor) => {
  const events: AgentActivityEvent[] = [];
  monitor.subscribe((e) => events.push(e));
  return events;
};

const slot = { ...formatDualTime(new Date('2026-10-03T12:30:00Z')), utc: '2026-10-03T12:30:00.000Z' };
const page = { id: 'page-1', url: 'https://www.notion.so/page-1' };

// ---------- Swytchcode CLI executor ----------

function fakeRunner(result: CliResult) {
  const inputs: string[] = [];
  const run = async (stdin: string) => {
    inputs.push(stdin);
    return result;
  };
  return { run, inputs };
}

test('SwyCliExecutor sends {tool, args} on stdin and parses the JSON response', async () => {
  const { run, inputs } = fakeRunner({ code: 0, stdout: '{"id":"abc","url":"https://notion.so/abc"}\n', stderr: '' });
  const executor = new SwyCliExecutor({ run });

  const result = await executor.exec('notion.page.create', { body: { a: 1 } });

  assert.deepEqual(JSON.parse(inputs[0]), { tool: 'notion.page.create', args: { body: { a: 1 } } });
  assert.deepEqual(result, { id: 'abc', url: 'https://notion.so/abc' });
});

test('SwyCliExecutor unwraps a single return-variable envelope', async () => {
  const { run } = fakeRunner({ code: 0, stdout: '{"resend_email_create":{"id":"em_1"}}', stderr: '' });
  assert.deepEqual(await new SwyCliExecutor({ run }).exec('resend.email.create', {}), { id: 'em_1' });
});

test('SwyCliExecutor turns kernel errors into SwytchcodeError with category and hint', async () => {
  const stderr = [
    '2026/09/26 14:19:09 [swytchcode exec] request tool=resend.email.create {}',
    '{"error":"missing credentials for Resend - run `swytchcode auth connect Resend`","category":"auth","suggested_action":"run swytchcode login"}',
    '2026/09/26 14:19:09 [swytchcode exec] failed tool=resend.email.create exit_code=3',
  ].join('\n');
  const { run } = fakeRunner({ code: 3, stdout: '', stderr });

  await assert.rejects(new SwyCliExecutor({ run }).exec('resend.email.create', {}), (err: unknown) => {
    assert.ok(err instanceof SwytchcodeError);
    assert.equal(err.exitCode, 3);
    assert.equal(err.category, 'auth');
    assert.equal(err.tool, 'resend.email.create');
    assert.match(err.message, /missing credentials for Resend/);
    return true;
  });
});

test('SwyCliExecutor reports unparseable output', async () => {
  const { run } = fakeRunner({ code: 0, stdout: 'not json', stderr: '' });
  await assert.rejects(new SwyCliExecutor({ run }).exec('resend.email.create', {}), /non-JSON output/);
});

test('createToolExecutor uses the mock in mock mode and the swy CLI in live mode', () => {
  assert.equal(createToolExecutor(loadConfig({})).mode, 'mock');
  assert.equal(createToolExecutor(loadConfig({ DEMO_MODE: 'live' })).mode, 'live');
});

// ---------- telemetry wrapper ----------

test('callTool resolves the alias, executes, and logs call + result telemetry', async () => {
  const executor = new MockToolExecutor();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);

  const result = await callTool({ executor, monitor }, 'Growth', 'resend.send_email', { body: { to: 'a@example.com' } });

  assert.equal(executor.calls[0].tool, 'resend.email.create');
  assert.ok((result as { id: string }).id);
  assert.deepEqual(events.map((e) => [e.agent, e.type]), [['Growth', 'tool_call'], ['Growth', 'tool_result']]);
  assert.match(events[0].summary, /resend\.email\.create/);
  assert.equal(typeof events[1].details?.latencyMs, 'number');
});

test('callTool logs an error event and rethrows on failure', async () => {
  const executor = new MockToolExecutor({ failures: { 'twitter_v2.tweet.create': new Error('rate limited') } });
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);

  await assert.rejects(callTool({ executor, monitor }, 'Growth', 'x.create_tweet', { body: {} }), /rate limited/);
  assert.equal(events.at(-1)?.type, 'error');
  assert.match(events.at(-1)!.summary, /twitter_v2\.tweet\.create.*rate limited/);
});

// ---------- tweet ----------

test('buildTweet includes topic, both time zones, the Notion link and hashtags', () => {
  const { text } = buildTweet({ topic: 'AI Agents', slot, pageUrl: page.url });

  for (const part of ['AI Agents', '18:00 IST', '21:30 JST', page.url, '#Antigravity', '#IndoJapanTech']) {
    assert.ok(text.includes(part), `tweet missing "${part}"`);
  }
  assert.ok(tweetLength(text) <= 280);
});

test('tweetLength weighs URLs as 23 and CJK characters as 2', () => {
  assert.equal(tweetLength('abc'), 3);
  assert.equal(tweetLength('勉強会'), 6);
  assert.equal(tweetLength(`see https://www.notion.so/${'x'.repeat(100)}`), 4 + 23);
});

test('buildTweet truncates an oversized topic to stay within 280', () => {
  const { text } = buildTweet({ topic: 'Agents '.repeat(80), slot, pageUrl: page.url });
  assert.ok(tweetLength(text) <= 280);
  assert.ok(text.includes('#IndoJapanTech'));
});

// ---------- sponsor email ----------

test('buildSponsorEmail personalises the pitch and links the event page and post', () => {
  const email = buildSponsorEmail({
    sponsor: { name: 'Priya Nair', email: 'priya@example.com', company: 'Mumbai AI Labs' },
    topic: 'AI Agents',
    slot,
    pageUrl: page.url,
    tweetUrl: 'https://x.com/i/web/status/42',
    from: 'organizer@example.com',
  });

  assert.equal(email.from, 'organizer@example.com');
  assert.deepEqual(email.to, ['priya@example.com']);
  assert.match(email.subject, /AI Agents/);
  for (const part of ['Dear Priya Nair', 'Mumbai AI Labs', page.url, 'https://x.com/i/web/status/42', '18:00 IST']) {
    assert.ok(email.text.includes(part), `text missing "${part}"`);
    assert.ok(email.html.includes(part), `html missing "${part}"`);
  }
});

test('buildSponsorEmail escapes HTML in sponsor data', () => {
  const email = buildSponsorEmail({
    sponsor: { name: '<b>Evil</b>', email: 'e@example.com', company: 'A & B' },
    topic: 'x',
    slot,
    pageUrl: page.url,
    tweetUrl: 'https://x.com/i/web/status/1',
    from: 'o@example.com',
  });
  assert.ok(email.html.includes('&lt;b&gt;Evil&lt;/b&gt;'));
  assert.ok(email.html.includes('A &amp; B'));
  assert.ok(!email.html.includes('<b>Evil</b>'));
});

// ---------- sponsor CRM ingestion ----------

test('parseSponsorRows reads name, email and company from a Notion query, skipping rows without email', () => {
  const sponsors = parseSponsorRows({
    results: [
      {
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'Priya Nair' }] },
          Email: { type: 'email', email: 'priya@example.com' },
          Company: { type: 'rich_text', rich_text: [{ plain_text: 'Mumbai AI Labs' }] },
        },
      },
      { properties: { Name: { type: 'title', title: [{ plain_text: 'No Email' }] }, Email: { type: 'email', email: null } } },
      { properties: { Name: { type: 'title', title: [{ plain_text: 'Kenji Sato' }] }, Email: { type: 'email', email: 'kenji@example.com' } } },
    ],
  });

  assert.deepEqual(sponsors, [
    { name: 'Priya Nair', email: 'priya@example.com', company: 'Mumbai AI Labs' },
    { name: 'Kenji Sato', email: 'kenji@example.com', company: 'Kenji Sato' },
  ]);
});

// ---------- growth agent ----------

const growthSettings = { fromEmail: 'organizer@example.com', sponsorDataSourceId: 'ds-sponsors' };

test('growth agent posts to X, then emails every Notion sponsor with the post link', async () => {
  const executor = new MockToolExecutor();
  const monitor = new AgentMonitor();
  const growth = createGrowthAgent({ executor, monitor, ...growthSettings });

  const outcome = await growth.promote({ topic: 'AI Agents', slot, page });

  assert.deepEqual(executor.calls.map((c) => c.tool), [
    'twitter_v2.tweet.create',
    'notion.query.create',
    ...DEMO_SPONSORS.map(() => 'resend.email.create'),
  ]);
  const [tweetCall, queryCall, ...emailCalls] = executor.calls;
  assert.ok((tweetCall.args.body as { text: string }).text.includes(page.url), 'Notion URL handed to X');
  assert.equal(queryCall.args.data_source_id, 'ds-sponsors');
  for (const call of emailCalls) {
    assert.ok((call.args.body as { text: string }).text.includes(outcome.tweet.url), 'tweet URL handed to Resend');
    assert.match(String(call.args['Idempotency-Key']), /^sponsor-invite:page-1:/);
  }
  assert.equal(outcome.emails.filter((e) => e.status === 'sent').length, DEMO_SPONSORS.length);
});

test('growth agent keeps emailing remaining sponsors when one send fails', async () => {
  const executor = new MockToolExecutor({ failEmailTo: [DEMO_SPONSORS[0].email] });
  const growth = createGrowthAgent({ executor, monitor: new AgentMonitor(), ...growthSettings });

  const outcome = await growth.promote({ topic: 'AI Agents', slot, page });

  assert.deepEqual(outcome.emails.map((e) => e.status), ['failed', ...DEMO_SPONSORS.slice(1).map(() => 'sent')]);
});

// ---------- orchestrator: full closed loop ----------

test('orchestrator runs Discord polls -> Notion page -> X post -> sponsor emails with data hand-offs', async () => {
  const transport = new MockDiscordTransport();
  const executor = new MockToolExecutor();
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const orchestrator = createOrchestrator({ transport, executor, monitor, settings: settingsFromConfig(loadConfig({})) });

  const result = await orchestrator.runEventPipeline({
    date: '2026-10-03',
    topics: ['AI Agents', 'RAG', 'Evals'],
    collectVotes: async (polls) => {
      transport.simulateVote(polls.topic.channelId, polls.topic.messageId, '3️⃣', 5); // Evals
      transport.simulateVote(polls.time.channelId, polls.time.messageId, '2️⃣', 4);
    },
  });

  // Poll consensus -> Notion page
  assert.equal(result.plan.topic, 'Evals');
  const pageCall = executor.calls.find((c) => c.tool === 'notion.page.create')!;
  assert.match(JSON.stringify(pageCall.args.body), /Evals/);

  // Notion page -> X post -> sponsor emails
  assert.equal(result.page.url, executor.pages[0].url);
  assert.ok(result.growth.tweet.text.includes(result.page.url));
  assert.equal(result.growth.emails.length, DEMO_SPONSORS.length);

  // Discord announcement links the Notion page
  const announcement = transport.sent.at(-1)!;
  assert.match(JSON.stringify(announcement.message), new RegExp(result.page.url));

  // Execution order and telemetry
  assert.deepEqual(
    [...new Set(executor.calls.map((c) => c.tool))],
    ['notion.page.create', 'twitter_v2.tweet.create', 'notion.query.create', 'resend.email.create'],
  );
  assert.equal(events[0].agent, 'Supervisor');
  assert.equal(events.at(-1)?.agent, 'Supervisor');
  assert.match(events.at(-1)!.summary, /complete/i);
  for (const agent of ['Event', 'Growth', 'Discord']) assert.ok(events.some((e) => e.agent === agent), `${agent} silent`);
});

test('orchestrator reports failure through the monitor and rethrows when Notion is down', async () => {
  const executor = new MockToolExecutor({ failures: { 'notion.page.create': new Error('Notion 503') } });
  const monitor = new AgentMonitor();
  const events = recordEvents(monitor);
  const orchestrator = createOrchestrator({
    transport: new MockDiscordTransport(),
    executor,
    monitor,
    settings: settingsFromConfig(loadConfig({})),
  });

  await assert.rejects(orchestrator.runEventPipeline({ date: '2026-10-03', topics: ['A', 'B'] }), /Notion 503/);
  assert.ok(!executor.calls.some((c) => c.tool === 'twitter_v2.tweet.create'), 'no tweet without a page');
  assert.equal(events.at(-1)?.agent, 'Supervisor');
  assert.equal(events.at(-1)?.type, 'error');
});

test('settingsFromConfig maps env keys and supplies mock defaults', () => {
  const mock = settingsFromConfig(loadConfig({}));
  assert.ok(mock.channelId && mock.parentPageId && mock.sponsorDataSourceId && mock.fromEmail);

  const live = settingsFromConfig(
    loadConfig({
      DEMO_MODE: 'live',
      DISCORD_CHANNEL_EVENTS_ID: 'chan',
      NOTION_PARENT_PAGE_ID: 'parent',
      NOTION_SPONSOR_DATA_SOURCE_ID: 'ds',
      RESEND_FROM_EMAIL: 'me@example.com',
    }),
  );
  assert.deepEqual(
    [live.channelId, live.parentPageId, live.sponsorDataSourceId, live.fromEmail],
    ['chan', 'parent', 'ds', 'me@example.com'],
  );
});
