// Phase 6 (TASK-05) contract: prompt parsing, demo HTTP server (UI, SSE, run API, bridge API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { AgentMonitor } from '../src/monitor/agent_monitor.ts';
import { loadConfig } from '../src/config/env.ts';
import { parsePrompt } from '../src/demo/prompt_parser.ts';
import { renderNotionPage, renderTweet } from '../src/demo/mock_views.ts';
import { createServer } from 'node:http';
import { createDemoServer, listenOn, type RunRecord } from '../src/demo/server.ts';

// ---------- prompt parsing ----------

const today = new Date('2026-09-26T03:00:00Z'); // Saturday in both India and Japan

test('parsePrompt uses an explicit topics list and ISO date', () => {
  const req = parsePrompt('Plan a meetup on 2026-10-10. Topics: Voice AI, Robotics, RAG', today);
  assert.equal(req.date, '2026-10-10');
  assert.deepEqual(req.topics, ['Voice AI', 'Robotics', 'RAG']);
});

test('parsePrompt recognises catalog topics and weekday names', () => {
  const req = parsePrompt('Host an evals and retrieval session next Wednesday', today);
  assert.equal(req.date, '2026-09-30');
  assert.deepEqual(req.topics.slice(0, 2), ['RAG', 'Evals']);
  assert.ok(req.topics.length >= 2);
});

test('parsePrompt defaults to next Saturday and three starter topics', () => {
  const req = parsePrompt('Host an Indo-Japan Hack Night, poll on Discord, doc in Notion, tweet', today);
  assert.equal(req.date, '2026-10-03');
  assert.deepEqual(req.topics, ['AI Agents', 'RAG', 'Evals']);
});

test('parsePrompt ends a topics list at a following "then" clause', () => {
  const req = parsePrompt(
    'Host an Indo-Japan AI study night next Saturday, poll the Discord on topics: AI Agents, RAG, Evals, then publish it in Notion, tweet it and pitch our sponsors.',
    today,
  );
  assert.deepEqual(req.topics, ['AI Agents', 'RAG', 'Evals']);
});

test('parsePrompt understands "tomorrow" and caps topics at five', () => {
  const req = parsePrompt('tomorrow. topics: a, b, c, d, e, f, g', today);
  assert.equal(req.date, '2026-09-27');
  assert.equal(req.topics.length, 5);
});

// ---------- server ----------

async function startServer(t: import('node:test').TestContext, stepDelayMs = 0) {
  const monitor = new AgentMonitor();
  const server = createDemoServer({ config: loadConfig({}), monitor, stepDelayMs, now: () => today });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, monitor };
}

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function waitForRun(base: string): Promise<RunRecord> {
  for (let i = 0; i < 200; i++) {
    const run = (await (await fetch(`${base}/api/run/latest`)).json()) as RunRecord;
    if (run.status === 'done' || run.status === 'failed') return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not finish');
}

test('GET / serves the single-screen demo UI', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const marker of ['Live Activity Monitor', '/api/events', '/api/run', '/api/bridge']) assert.ok(html.includes(marker), marker);
});

test('GET /api/status reports modes and live readiness', async (t) => {
  const { base } = await startServer(t);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.defaultMode, 'mock');
  assert.ok(Array.isArray(status.live.missingKeys));
  assert.ok(['mock', 'bot', 'webhook'].includes(status.live.discord));
  assert.ok(['sandbox', 'production', 'unknown'].includes(status.live.swytchcodeMode));
});

test('GET /api/run/latest is idle before any run', async (t) => {
  const { base } = await startServer(t);
  assert.deepEqual(await (await fetch(`${base}/api/run/latest`)).json(), { status: 'idle' });
});

test('POST /api/run validates its input', async (t) => {
  const { base } = await startServer(t);
  assert.equal((await postJson(`${base}/api/run`, '{not json')).status, 400);
  assert.equal((await postJson(`${base}/api/run`, {})).status, 400);
  assert.equal((await postJson(`${base}/api/run`, { prompt: 'x', mode: 'staging' })).status, 400);
  assert.equal((await postJson(`${base}/api/run`, { prompt: 'x'.repeat(2001) })).status, 400);
});

test('POST /api/run executes the closed loop in offline mode and exposes artifacts', async (t) => {
  const { base, monitor } = await startServer(t);

  const res = await postJson(`${base}/api/run`, { prompt: 'Host a RAG and evals night. Topics: RAG, Evals, Voice AI', mode: 'mock' });
  assert.equal(res.status, 202);
  const { id } = await res.json();

  const run = await waitForRun(base);
  assert.equal(run.id, id);
  assert.equal(run.status, 'done');
  assert.equal(run.mode, 'mock');
  assert.deepEqual(run.request.topics, ['RAG', 'Evals', 'Voice AI']);

  const a = run.artifacts!;
  assert.ok(['RAG', 'Evals', 'Voice AI'].includes(a.plan.topic));
  assert.match(a.plan.slot, /IST/);
  assert.match(a.notion.url, new RegExp(`^${base}/mock/notion/`));
  assert.match(a.x.url, new RegExp(`^${base}/mock/x/`));
  assert.ok(a.x.text.includes(a.notion.url), 'tweet links the Notion page');
  assert.equal(a.emails.length, 3);
  assert.ok(a.emails.every((e) => e.status === 'sent'));
  assert.equal(a.discord.polls, 2);
  assert.ok(a.discord.announced);

  const summaries = monitor.history().map((e) => `${e.agent}:${e.summary}`);
  assert.ok(summaries.some((s) => s.startsWith('Supervisor:Parsed request')));
  assert.ok(summaries.some((s) => s.startsWith('Supervisor:agent:complete')));
});

test('POST /api/run rejects a second run while one is in progress', async (t) => {
  const { base } = await startServer(t, 20);
  assert.equal((await postJson(`${base}/api/run`, { prompt: 'first' })).status, 202);
  assert.equal((await postJson(`${base}/api/run`, { prompt: 'second' })).status, 409);
  await waitForRun(base);
});

test('POST /api/bridge returns the bilingual embed for a Japanese message', async (t) => {
  const { base } = await startServer(t);
  const res = await postJson(`${base}/api/bridge`, { text: 'お盆休みはいつですか？' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lang, 'ja');
  assert.equal(body.embed.description, 'When is the Obon holiday?');
  assert.ok(body.embed.fields.some((f: { name: string }) => f.name === 'Cultural context'));
});

test('POST /api/bridge returns no embed for plain English', async (t) => {
  const { base } = await startServer(t);
  const body = await (await postJson(`${base}/api/bridge`, { text: 'See you at the meetup!' })).json();
  assert.deepEqual(body, { lang: 'en', embed: null });
});

test('unknown routes return 404', async (t) => {
  const { base } = await startServer(t);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('listenOn rejects with an actionable message when the port is taken', async (t) => {
  const blocker = createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => blocker.close());
  const { port } = blocker.address() as AddressInfo;

  const server = createDemoServer({ config: loadConfig({}) });
  await assert.rejects(listenOn(server, port, '127.0.0.1'), (err: Error) => {
    assert.match(err.message, new RegExp(`Port ${port} is already in use`));
    assert.match(err.message, /PORT=/);
    return true;
  });
});

test('listenOn resolves once the server is listening', async (t) => {
  const server = createDemoServer({ config: loadConfig({}) });
  await listenOn(server, 0, '127.0.0.1');
  t.after(() => server.close());
  assert.ok(server.listening);
});

// ---------- viewable mock artifacts ----------

const samplePage = {
  id: 'mock-page-1',
  url: 'http://localhost:3000/mock/notion/mock-page-1',
  title: 'Antigravity Fan Club: RAG / 勉強会',
  createdAt: '2026-09-26T09:00:00.000Z',
  body: {
    children: [
      { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '📅 When / 日時' } }] } },
      { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '<script>alert(1)</script>' } }] } },
      { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: 'RAG — 7 votes' } }] } },
    ],
  },
};

test('renderNotionPage shows the title and blocks as a Notion-style page, escaping text', () => {
  const html = renderNotionPage(samplePage);
  assert.ok(html.includes('Antigravity Fan Club: RAG / 勉強会'));
  assert.match(html, /<h2[^>]*>📅 When \/ 日時<\/h2>/);
  assert.match(html, /<li[^>]*>RAG — 7 votes<\/li>/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /mock/i);
});

test('renderTweet shows the post with linked URLs and hashtags, escaping text', () => {
  const html = renderTweet({
    id: 'mock-tweet-2',
    url: 'http://localhost:3000/mock/x/mock-tweet-2',
    text: 'Study session <b>RAG</b>\nhttp://localhost:3000/mock/notion/mock-page-1\n#Antigravity #IndoJapanTech',
    createdAt: '2026-09-26T09:00:00.000Z',
  });
  assert.ok(html.includes('<a href="http://localhost:3000/mock/notion/mock-page-1"'));
  assert.match(html, /<span class="tag">#Antigravity<\/span>/);
  assert.ok(html.includes('&lt;b&gt;RAG&lt;/b&gt;'));
  assert.match(html, /mock/i);
});

test('the demo server serves the Notion page and X post produced by an offline run', async (t) => {
  const { base } = await startServer(t);
  await postJson(`${base}/api/run`, { prompt: 'Topics: RAG, Evals', mode: 'mock' });
  const { artifacts } = await waitForRun(base);

  const notion = await fetch(artifacts!.notion.url);
  assert.equal(notion.status, 200);
  assert.match(notion.headers.get('content-type') ?? '', /text\/html/);
  assert.ok((await notion.text()).includes(artifacts!.notion.title));

  const post = await fetch(artifacts!.x.url);
  assert.equal(post.status, 200);
  assert.ok((await post.text()).includes('#IndoJapanTech'));

  assert.equal((await fetch(`${base}/mock/notion/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/mock/x/unknown`)).status, 404);
});
