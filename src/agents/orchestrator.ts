// Supervisor for the closed-loop event pipeline:
//   Discord polls -> votes -> Notion event page -> Discord announcement -> X post -> sponsor emails.
import type { AppConfig } from '../config/env.ts';
import type { AgentMonitor } from '../monitor/agent_monitor.ts';
import { EMBED_COLOR, type DiscordTransport } from '../discord/discord_client.ts';
import { callTool, type ToolExecutor } from '../swytchcode/executor.ts';
import { createEventAgent, eventTitle, type EventPlan, type EventPolls } from './event_agent.ts';
import { createGrowthAgent, type GrowthOutcome, type NotionPageRef } from './growth_agent.ts';

export interface OrchestratorSettings {
  channelId: string;
  parentPageId: string;
  sponsorDataSourceId: string;
  fromEmail: string;
  notionVersion?: string;
}

/** Env values, with placeholders so mock mode runs with an empty environment. */
export function settingsFromConfig({ env }: AppConfig): OrchestratorSettings {
  return {
    channelId: env.DISCORD_CHANNEL_EVENTS_ID ?? 'events',
    parentPageId: env.NOTION_PARENT_PAGE_ID ?? 'mock-parent-page',
    sponsorDataSourceId: env.NOTION_SPONSOR_DATA_SOURCE_ID ?? 'mock-sponsor-data-source',
    fromEmail: env.RESEND_FROM_EMAIL ?? 'organizer@example.com',
    notionVersion: env.NOTION_API_VERSION,
  };
}

export interface OrchestratorOptions {
  transport: DiscordTransport;
  executor: ToolExecutor;
  monitor: AgentMonitor;
  settings: OrchestratorSettings;
}

export interface PipelineRequest {
  /** India calendar date for the event (YYYY-MM-DD). */
  date: string;
  topics: string[];
  /** Runs between opening and tallying the polls: wait in live mode, simulate votes in mock mode. */
  collectVotes?: (polls: EventPolls) => Promise<void>;
}

export interface PipelineResult {
  plan: EventPlan;
  page: NotionPageRef;
  growth: GrowthOutcome;
}

const notionUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, '')}`;

export function createOrchestrator({ transport, executor, monitor, settings }: OrchestratorOptions) {
  const eventAgent = createEventAgent({ transport, monitor, channelId: settings.channelId, parentPageId: settings.parentPageId });
  const growthAgent = createGrowthAgent({ executor, monitor, ...settings });

  async function runEventPipeline({ date, topics, collectVotes }: PipelineRequest): Promise<PipelineResult> {
    monitor.logStatus('Supervisor', `agent:start: event pipeline for ${date}`, { topics, mode: executor.mode });
    try {
      // 1. Ask the community (Discord polls) and wait for votes.
      const polls = await eventAgent.openPolls({ date, topics });
      await collectVotes?.(polls);

      // 2. Consensus -> Notion event page.
      const plan = await eventAgent.planEvent(polls);
      const created = (await callTool({ executor, monitor }, 'Event', 'notion.create_page', {
        body: plan.notionPage,
        ...(settings.notionVersion && { 'Notion-Version': settings.notionVersion }),
      })) as { id: string; url?: string };
      const page = { id: created.id, url: created.url ?? notionUrl(created.id) };

      // 3. Announce on Discord with the Notion link.
      monitor.logToolCall('Discord', 'Announcing the event in #events', { pageUrl: page.url });
      await transport.sendMessage(settings.channelId, {
        embeds: [
          {
            title: `📣 ${eventTitle(plan.topic)}`,
            description: `🗓 ${plan.slot.label}\n📄 ${page.url}`,
            color: EMBED_COLOR,
          },
        ],
      });
      monitor.logToolResult('Discord', 'Event announced');

      // 4. Notion page -> X post -> sponsor outreach.
      const growth = await growthAgent.promote({ topic: plan.topic, slot: plan.slot, page });

      monitor.logStatus('Supervisor', `agent:complete: ${plan.topic} scheduled, promoted and pitched to ${growth.sponsors.length} sponsors`);
      return { plan, page, growth };
    } catch (error) {
      monitor.logError('Supervisor', `Pipeline aborted: ${(error as Error).message}`);
      throw error;
    }
  }

  return { runEventPipeline };
}
