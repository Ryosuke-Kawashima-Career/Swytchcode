// Phase 2 (TASK-07) contract: in-memory activity bus, console printer, SSE stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

import { AgentMonitor, type AgentActivityEvent } from '../src/monitor/agent_monitor.ts';
import { attachConsolePrinter, formatConsoleLine } from '../src/monitor/console_printer.ts';
import { createSseHandler, toSseFrame } from '../src/monitor/sse_handler.ts';

const fixedClock = () => new Date('2026-09-26T12:00:01.000Z');

test('log helpers emit schema-conformant events to subscribers', () => {
  const monitor = new AgentMonitor({ now: fixedClock });
  const seen: AgentActivityEvent[] = [];
  monitor.subscribe((e) => seen.push(e));

  monitor.logThought('Bridge', 'Detected Japanese honorific "-san"');
  monitor.logToolCall('Growth', 'Calling twitter_v2.tweet.create', { text: 'hi' });
  monitor.logToolResult('Growth', 'Tweet posted', { id: '1' });
  monitor.logStatus('Supervisor', 'agent:complete');
  monitor.logError('Event', 'Notion timeout', { status: 504 });

  assert.deepEqual(seen.map((e) => e.type), ['thought', 'tool_call', 'tool_result', 'status', 'error']);
  assert.deepEqual(seen[1], {
    timestamp: '2026-09-26T12:00:01.000Z',
    agent: 'Growth',
    type: 'tool_call',
    summary: 'Calling twitter_v2.tweet.create',
    details: { text: 'hi' },
  });
  assert.equal('details' in seen[0], false, 'details omitted when not provided');
});

test('history is a ring buffer keeping the most recent events in order', () => {
  const monitor = new AgentMonitor({ capacity: 3 });
  for (let i = 1; i <= 5; i++) monitor.logStatus('Supervisor', `step ${i}`);

  assert.deepEqual(monitor.history().map((e) => e.summary), ['step 3', 'step 4', 'step 5']);
});

test('default history capacity is 100', () => {
  const monitor = new AgentMonitor();
  for (let i = 0; i < 150; i++) monitor.logStatus('Supervisor', `step ${i}`);

  const history = monitor.history();
  assert.equal(history.length, 100);
  assert.equal(history[0].summary, 'step 50');
});

test('history returns a copy that callers cannot mutate', () => {
  const monitor = new AgentMonitor();
  monitor.logStatus('Supervisor', 'a');
  monitor.history().length = 0;
  assert.equal(monitor.history().length, 1);
});

test('unsubscribe removes the listener', () => {
  const monitor = new AgentMonitor();
  let calls = 0;
  const unsubscribe = monitor.subscribe(() => calls++);
  assert.equal(monitor.subscriberCount(), 1);

  monitor.logStatus('Supervisor', 'one');
  unsubscribe();
  monitor.logStatus('Supervisor', 'two');

  assert.equal(calls, 1);
  assert.equal(monitor.subscriberCount(), 0);
});

test('formatConsoleLine renders time, agent, type and summary', () => {
  const monitor = new AgentMonitor({ now: fixedClock });
  monitor.logToolCall('Growth', 'Calling resend.email.create');
  const [event] = monitor.history();

  assert.equal(formatConsoleLine(event, { color: false }), '12:00:01 [Growth] tool_call  Calling resend.email.create');
  assert.match(formatConsoleLine(event, { color: true }), /\x1b\[\d+m/);
});

test('attachConsolePrinter writes each event and detaches cleanly', () => {
  const monitor = new AgentMonitor({ now: fixedClock });
  const lines: string[] = [];
  const detach = attachConsolePrinter(monitor, { write: (l) => lines.push(l), color: false });

  monitor.logThought('Bridge', 'thinking');
  detach();
  monitor.logThought('Bridge', 'ignored');

  assert.deepEqual(lines, ['12:00:01 [Bridge] thought    thinking']);
  assert.equal(monitor.subscriberCount(), 0);
});

test('toSseFrame produces a single data frame', () => {
  const monitor = new AgentMonitor({ now: fixedClock });
  monitor.logStatus('Discord', 'multi\nline');
  const frame = toSseFrame(monitor.history()[0]);

  assert.ok(frame.startsWith('data: {'));
  assert.ok(frame.endsWith('\n\n'));
  assert.equal(frame.split('\n').length, 3, 'newlines in payload are JSON-escaped');
});

test('SSE handler replays history, streams live events, and cleans up on disconnect', async (t) => {
  const monitor = new AgentMonitor({ now: fixedClock });
  monitor.logStatus('Supervisor', 'before connect');

  const server = createServer(createSseHandler(monitor));
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readEvents = async (count: number) => {
    while (buffer.split('\n\n').length - 1 < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer
      .split('\n\n')
      .filter(Boolean)
      .map((f) => JSON.parse(f.replace(/^data: /, '')) as AgentActivityEvent);
  };

  assert.deepEqual((await readEvents(1)).map((e) => e.summary), ['before connect']);
  assert.equal(monitor.subscriberCount(), 1);

  monitor.logToolResult('Event', 'Notion page created', { url: 'https://notion.so/x' });
  const events = await readEvents(2);
  assert.equal(events[1].summary, 'Notion page created');
  assert.deepEqual(events[1].details, { url: 'https://notion.so/x' });

  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && monitor.subscriberCount() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(monitor.subscriberCount(), 0, 'listener removed after client disconnect');
});
