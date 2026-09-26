// Single-screen live demo server (TASK-05 / REQ-04). Zero dependencies: node:http only.
//   GET  /                 demo UI (index.html)
//   GET  /api/events       SSE stream of AgentMonitor activity
//   GET  /api/status       default mode + live-mode readiness
//   POST /api/run          start the closed-loop pipeline { prompt, mode }
//   GET  /api/run/latest   state and artifacts of the most recent run
//   POST /api/bridge       Cultural Bridge try-it { text }
//   GET  /mock/notion/:id  Notion page created by an offline run
//   GET  /mock/x/:id       X post created by an offline run
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { loadConfig, type AppConfig, type DemoMode } from '../config/env.ts';
import { AgentMonitor, monitor as sharedMonitor } from '../monitor/agent_monitor.ts';
import { attachConsolePrinter } from '../monitor/console_printer.ts';
import { createSseHandler } from '../monitor/sse_handler.ts';
import { createDiscordClient, type DiscordEmbed, type DiscordTransport } from '../discord/discord_client.ts';
import { MockDiscordTransport } from '../discord/mock_discord.ts';
import { createThreadResponder, detectLanguage } from '../discord/thread_responder.ts';
import { SwyCliExecutor, type ToolExecutor } from '../swytchcode/executor.ts';
import { MockArtifactStore, MockToolExecutor } from '../swytchcode/mock_executor.ts';
import { createBridgeAgent, createPhrasebookTranslator, DEMO_PHRASEBOOK } from '../agents/bridge_agent.ts';
import { eventTitle, type EventPolls } from '../agents/event_agent.ts';
import type { EmailOutcome } from '../agents/growth_agent.ts';
import { createOrchestrator, settingsFromConfig } from '../agents/orchestrator.ts';
import { parsePrompt, type PipelineInput } from './prompt_parser.ts';
import { renderNotionPage, renderTweet } from './mock_views.ts';

const MAX_TEXT = 2000;
const MAX_BODY_BYTES = 16 * 1024;
const INDEX_HTML = fileURLToPath(new URL('./index.html', import.meta.url));

export interface RunArtifacts {
  plan: { topic: string; date: string; slot: string };
  discord: { mode: DiscordTransport['mode']; channelId: string; polls: number; announced: boolean };
  notion: { id: string; url: string; title: string };
  x: { id: string; url: string; text: string };
  emails: Array<EmailOutcome & { company: string }>;
}

export interface RunRecord {
  id: string;
  status: 'running' | 'done' | 'failed';
  mode: DemoMode;
  prompt: string;
  request: PipelineInput;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  artifacts?: RunArtifacts;
}

export interface DemoServerOptions {
  config: AppConfig;
  monitor?: AgentMonitor;
  /** Pause between simulated steps in offline mode so judges can follow the feed. */
  stepDelayMs?: number;
  /** How long live mode waits for real Discord votes. */
  pollWindowMs?: number;
  now?: () => Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function requireText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `"${key}" must be a non-empty string`);
  if (value.length > MAX_TEXT) throw new HttpError(400, `"${key}" must be at most ${MAX_TEXT} characters`);
  return value.trim();
}

function swytchcodeMode(): 'sandbox' | 'production' | 'unknown' {
  try {
    const { mode } = JSON.parse(readFileSync('.swytchcode/tooling.json', 'utf8'));
    return mode === 'sandbox' || mode === 'production' ? mode : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createDemoServer({
  config,
  monitor = new AgentMonitor(),
  stepDelayMs = 400,
  pollWindowMs = 60_000,
  now = () => new Date(),
}: DemoServerOptions) {
  const sse = createSseHandler(monitor);
  const mockStore = new MockArtifactStore(); // shared by all offline runs so /mock links keep working
  let latest: RunRecord | undefined;
  let runCounter = 0;

  // ---------- pipeline run ----------

  async function execute(run: RunRecord) {
    const runConfig: AppConfig = { ...config, demoMode: run.mode };
    const transport = createDiscordClient(runConfig);
    const executor: ToolExecutor =
      run.mode === 'live'
        ? new SwyCliExecutor()
        : new MockToolExecutor({ latencyMs: stepDelayMs, store: mockStore, baseUrl: localOrigin() });
    const settings = settingsFromConfig(runConfig);
    const orchestrator = createOrchestrator({ transport, executor, monitor, settings });

    // Offline: simulated members vote. Live: wait for the real community.
    const collectVotes = async (polls: EventPolls) => {
      if (transport instanceof MockDiscordTransport) {
        monitor.logThought('Event', 'Waiting for community votes (simulated members in Japan and India)');
        await sleep(stepDelayMs * 3);
        polls.topic.poll.options.forEach((o, i) => transport.simulateVote(polls.topic.channelId, polls.topic.messageId, o.emoji, [4, 7, 3, 5, 2][i % 5]));
        polls.time.poll.options.forEach((o, i) => transport.simulateVote(polls.time.channelId, polls.time.messageId, o.emoji, [3, 2, 6][i % 3]));
      } else {
        monitor.logThought('Event', `Waiting ${Math.round(pollWindowMs / 1000)}s for Discord votes`);
        await sleep(pollWindowMs);
      }
    };

    try {
      const result = await orchestrator.runEventPipeline({ ...run.request, collectVotes });
      const companies = new Map(result.growth.sponsors.map((s) => [s.email, s.company]));
      run.artifacts = {
        plan: { topic: result.plan.topic, date: run.request.date, slot: result.plan.slot.label },
        discord: { mode: transport.mode, channelId: settings.channelId, polls: 2, announced: true },
        notion: { id: result.page.id, url: result.page.url, title: eventTitle(result.plan.topic) },
        x: result.growth.tweet,
        emails: result.growth.emails.map((e) => ({ ...e, company: companies.get(e.to) ?? e.to })),
      };
      run.status = 'done';
    } catch (error) {
      run.status = 'failed';
      run.error = (error as Error).message;
    } finally {
      run.finishedAt = now().toISOString();
      transport.close();
    }
  }

  function startRun(body: Record<string, unknown>): RunRecord {
    const prompt = requireText(body, 'prompt');
    const mode = body.mode ?? config.demoMode;
    if (mode !== 'mock' && mode !== 'live') throw new HttpError(400, '"mode" must be "mock" or "live"');
    if (latest?.status === 'running') throw new HttpError(409, 'A run is already in progress');

    const request = parsePrompt(prompt, now());
    const run: RunRecord = { id: `run-${++runCounter}`, status: 'running', mode, prompt, request, startedAt: now().toISOString() };
    latest = run;
    monitor.logThought('Supervisor', `Parsed request: ${request.date}, topics ${request.topics.join(' / ')}`, { mode });
    void execute(run);
    return run;
  }

  /** Origin the mock links point at: the exact bound address (avoids `localhost` resolving to ::1 first). */
  function localOrigin() {
    const { address, port } = server.address() as AddressInfo;
    const host = address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address; // wildcard binds aren't linkable
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }

  function sendHtml(res: ServerResponse, html: string) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  // ---------- cultural bridge try-it ----------

  async function bridge(body: Record<string, unknown>): Promise<{ lang: string; embed: DiscordEmbed | null }> {
    const text = requireText(body, 'text');
    const transport = new MockDiscordTransport();
    const agent = createBridgeAgent({ monitor, translate: createPhrasebookTranslator(DEMO_PHRASEBOOK) });
    const responder = createThreadResponder({ transport, monitor, channelIds: ['general'], annotate: agent.annotate });

    await responder.handle(transport.simulateIncoming({ channelId: 'general', content: text, authorName: 'demo-user' }, { dispatch: false }));
    return { lang: detectLanguage(text), embed: transport.sent[0]?.message.embeds?.[0] ?? null };
  }

  // ---------- routing ----------

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = `${req.method} ${path}`;
    try {
      switch (route) {
        case 'GET /':
        case 'GET /index.html':
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(readFileSync(INDEX_HTML)); // read per request so edits show up without a restart
          return;
        case 'GET /api/events':
          return sse(req, res);
        case 'GET /api/status': {
          const live: AppConfig = { ...config, demoMode: 'live' };
          const discord = createDiscordClient(live);
          discord.close();
          return sendJson(res, 200, {
            defaultMode: config.demoMode,
            live: { discord: discord.mode, swytchcodeMode: swytchcodeMode(), missingKeys: config.missingLiveKeys },
          });
        }
        case 'POST /api/run': {
          const run = startRun(await readJson(req));
          return sendJson(res, 202, { id: run.id, request: run.request });
        }
        case 'GET /api/run/latest':
          return sendJson(res, 200, latest ?? { status: 'idle' });
        case 'POST /api/bridge':
          return sendJson(res, 200, await bridge(await readJson(req)));
        default: {
          // Offline artifacts: /mock/notion/:id and /mock/x/:id
          const mock = req.method === 'GET' ? path.match(/^\/mock\/(notion|x)\/([\w-]+)$/) : null;
          const page = mock?.[1] === 'notion' ? mockStore.pages.get(mock[2]) : undefined;
          const tweet = mock?.[1] === 'x' ? mockStore.tweets.get(mock[2]) : undefined;
          if (page) return sendHtml(res, renderNotionPage(page));
          if (tweet) return sendHtml(res, renderTweet(tweet));
          return sendJson(res, 404, { error: mock ? 'No such mock artifact (offline runs are kept in memory until restart)' : `No route for ${route}` });
        }
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(res, status, { error: (error as Error).message });
    }
  });
  return server;
}

/** Starts listening; rejects with an actionable message instead of an unhandled 'error' event. */
export function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      const hint =
        error.code === 'EADDRINUSE'
          ? `Port ${port} is already in use (another demo server or dev tool is running). ` +
            `Stop it, or set PORT=<free port> in .env.`
          : error.code === 'EACCES'
            ? `No permission to listen on port ${port}. Set PORT=<port above 1024> in .env.`
            : `Could not listen on ${host}:${port}: ${error.message}`;
      reject(new Error(hint, { cause: error }));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// ---------- entry point (`npm run dev`) ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  attachConsolePrinter(sharedMonitor);
  const pollWindowMs = Number(process.env.POLL_WINDOW_SECONDS ?? 60) * 1000;
  const server = createDemoServer({ config, monitor: sharedMonitor, pollWindowMs });
  // Loopback only: live mode can post and send email on the organizer's behalf.
  listenOn(server, config.port, '127.0.0.1').then(
    () => console.log(`Demo UI: http://localhost:${config.port}  (default mode: ${config.demoMode})`),
    (error: Error) => {
      console.error(`✖ ${error.message}`);
      process.exitCode = 1;
    },
  );
}
