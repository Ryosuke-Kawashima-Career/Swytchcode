// `npm run demo:simulate`: end-to-end offline run in the terminal (no credentials, no network).
// Cultural Bridge on sample messages, then the closed loop: polls -> Notion -> X -> sponsor emails.
import { AgentMonitor } from '../monitor/agent_monitor.ts';
import { attachConsolePrinter } from '../monitor/console_printer.ts';
import { MockDiscordTransport } from '../discord/mock_discord.ts';
import { createThreadResponder } from '../discord/thread_responder.ts';
import { MockToolExecutor } from '../swytchcode/mock_executor.ts';
import { createBridgeAgent, createPhrasebookTranslator, DEMO_PHRASEBOOK } from '../agents/bridge_agent.ts';
import { createOrchestrator, settingsFromConfig } from '../agents/orchestrator.ts';
import { loadConfig } from '../config/env.ts';
import { parsePrompt } from './prompt_parser.ts';

const monitor = new AgentMonitor();
attachConsolePrinter(monitor);
const transport = new MockDiscordTransport();
const executor = new MockToolExecutor();

// 1. Cultural Bridge: members post in #general, the agent replies in threads.
const bridge = createBridgeAgent({ monitor, translate: createPhrasebookTranslator(DEMO_PHRASEBOOK) });
const responder = createThreadResponder({ transport, monitor, channelIds: ['general'], annotate: bridge.annotate });
const stop = responder.start();
for (const content of ['お盆休みはいつですか？', 'दिवाली की शुभकामनाएं', 'See you at the meetup!']) {
  transport.simulateIncoming({ channelId: 'general', content });
}
await transport.idle();
stop();

// 2. Closed loop from a natural-language request.
const prompt = 'Host an Indo-Japan study night next Saturday. Topics: AI Agents, RAG, Evals';
const request = parsePrompt(prompt);
monitor.logThought('Supervisor', `Parsed request: ${request.date}, topics ${request.topics.join(' / ')}`);

const orchestrator = createOrchestrator({ transport, executor, monitor, settings: settingsFromConfig(loadConfig({})) });
const result = await orchestrator.runEventPipeline({
  ...request,
  collectVotes: async (polls) => {
    transport.simulateVote(polls.topic.channelId, polls.topic.messageId, '2️⃣', 7);
    transport.simulateVote(polls.time.channelId, polls.time.messageId, '3️⃣', 6);
  },
});

// 3. Summary of produced artifacts.
const sent = result.growth.emails.filter((e) => e.status === 'sent').length;
console.log(`
── Artifacts ─────────────────────────────────────────
Discord : ${transport.threads.length} bridge threads, 2 polls, 1 announcement
Notion  : ${result.page.url}
X       : ${result.growth.tweet.url}
Resend  : ${sent}/${result.growth.emails.length} sponsor emails sent
Swytchcode calls: ${executor.calls.map((c) => c.tool).join(' → ')}`);
