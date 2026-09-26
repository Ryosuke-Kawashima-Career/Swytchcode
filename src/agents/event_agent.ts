// Event Orchestrator agent (TASK-03 / REQ-02).
// Proposes IST/JST-friendly time slots, runs topic + time polls on Discord, reads the
// community's votes, and drafts the Notion event page (body for `notion.page.create`).
import type { AgentMonitor } from '../monitor/agent_monitor.ts';
import type { DiscordTransport } from '../discord/discord_client.ts';
import {
  buildTopicPoll,
  collectPollResults,
  postTopicPoll,
  type PollResult,
  type PostedPoll,
} from '../discord/poll_handler.ts';

// ---------- time zones ----------

// Neither India nor Japan observes daylight saving, so fixed offsets are exact.
const OFFSET_MINUTES = { IST: 330, JST: 540 } as const;
const TIME_ZONES = { IST: 'Asia/Kolkata', JST: 'Asia/Tokyo' } as const;

export interface DualTime {
  ist: string;
  jst: string;
  label: string;
}

export interface TimeSlot extends DualTime {
  utc: string;
}

function formatZone(date: Date, zone: keyof typeof TIME_ZONES): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONES[zone],
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.month} ${parts.day} · ${parts.hour}:${parts.minute} ${zone}`;
}

/** e.g. "Sat, Oct 3 · 18:00 IST / 21:30 JST" (the JST date is dropped when it matches IST). */
export function formatDualTime(date: Date): DualTime {
  const ist = formatZone(date, 'IST');
  const jst = formatZone(date, 'JST');
  const [istDay] = ist.split(' · ');
  const [jstDay, jstTime] = jst.split(' · ');
  return { ist, jst, label: `${ist} / ${istDay === jstDay ? jstTime : jst}` };
}

export interface SlotOptions {
  count?: number;
  durationMinutes?: number;
  /** Earliest local start hour, applied in both countries. */
  startHour?: number;
  /** Latest local end hour, applied in both countries. */
  endHour?: number;
}

/**
 * Slots on the given India calendar date (YYYY-MM-DD) where the whole event fits inside
 * [startHour, endHour) local time in both India and Japan, spread evenly across that window.
 */
export function suggestTimeSlots(
  date: string,
  { count = 3, durationMinutes = 60, startHour = 9, endHour = 22 }: SlotOptions = {},
): TimeSlot[] {
  // 1. Walk the IST day in 30-minute steps (midnight IST = previous day 18:30 UTC).
  const dayStartUtc = Date.parse(`${date}T00:00:00Z`) - OFFSET_MINUTES.IST * 60_000;
  const fits = (utcMs: number, offset: number) => {
    const localMinute = (((utcMs / 60_000 + offset) % 1440) + 1440) % 1440;
    return localMinute >= startHour * 60 && localMinute + durationMinutes <= endHour * 60;
  };

  // 2. Keep starts that are comfortable on both sides.
  const candidates: number[] = [];
  for (let t = dayStartUtc; t < dayStartUtc + 86_400_000; t += 30 * 60_000) {
    if (fits(t, OFFSET_MINUTES.IST) && fits(t, OFFSET_MINUTES.JST)) candidates.push(t);
  }

  // 3. Pick `count` evenly spaced slots (earliest to latest).
  const picked =
    candidates.length <= count
      ? candidates
      : Array.from({ length: count }, (_, i) => candidates[count === 1 ? 0 : Math.round((i * (candidates.length - 1)) / (count - 1))]);

  return picked.map((t) => {
    const date = new Date(t);
    return { utc: date.toISOString(), ...formatDualTime(date) };
  });
}

// ---------- Notion page ----------

type RichText = Array<{ type: 'text'; text: { content: string } }>;
export type NotionBlock = { object: 'block'; type: string } & Record<string, unknown>;

export interface NotionPageBody {
  parent: { page_id: string };
  properties: { title: { title: Array<{ text: { content: string } }> } };
  children: NotionBlock[];
}

const richText = (content: string): RichText => [{ type: 'text', text: { content } }];
const block = (type: string, content: string): NotionBlock => ({ object: 'block', type, [type]: { rich_text: richText(content) } });

export interface EventPageInput {
  parentPageId: string;
  topic: string;
  slot: TimeSlot;
  results: PollResult['results'];
}

export function eventTitle(topic: string): string {
  return `Antigravity Fan Club: ${topic} / 勉強会`;
}

/** Request body for Swytchcode `notion.page.create`. */
export function buildNotionEventPage({ parentPageId, topic, slot, results }: EventPageInput): NotionPageBody {
  return {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: eventTitle(topic) } }] } },
    children: [
      block('heading_2', '📅 When / 日時'),
      block('paragraph', `🇮🇳 ${slot.ist}`),
      block('paragraph', `🇯🇵 ${slot.jst}`),
      block('paragraph', `UTC: ${slot.utc}`),
      block('heading_2', '🗳️ Community vote / 投票結果'),
      ...results.map((r) => block('bulleted_list_item', `${r.option} — ${r.votes} vote${r.votes === 1 ? '' : 's'}`)),
      block('heading_2', '🌏 About / 概要'),
      block('paragraph', `A bilingual study session on ${topic} for the Japanese and Indian members of the Antigravity Fan Club.`),
      block('paragraph', `日本とインドのメンバーによる「${topic}」をテーマにしたバイリンガル勉強会です。`),
    ],
  };
}

// ---------- agent ----------

export interface EventAgentOptions {
  transport: DiscordTransport;
  monitor: AgentMonitor;
  channelId: string;
  parentPageId: string;
}

export interface EventPolls {
  topic: PostedPoll;
  time: PostedPoll;
  slots: TimeSlot[];
}

export interface EventPlan {
  topic: string;
  slot: TimeSlot;
  topicResults: PollResult;
  timeResults: PollResult;
  notionPage: NotionPageBody;
}

export function createEventAgent({ transport, monitor, channelId, parentPageId }: EventAgentOptions) {
  const deps = { transport, monitor };

  async function openPolls({ date, topics, slotCount = 3 }: { date: string; topics: string[]; slotCount?: number }): Promise<EventPolls> {
    // 1. Balance time zones before asking the community.
    const slots = suggestTimeSlots(date, { count: slotCount });
    if (slots.length < 2) throw new Error(`Not enough IST/JST-friendly slots on ${date} for a poll`);
    monitor.logThought('Event', `Balanced IST/JST: ${slots.length} slots comfortable in both countries`, {
      slots: slots.map((s) => s.label),
    });

    // 2. Post both polls to the events channel.
    const topic = await postTopicPoll(deps, channelId, buildTopicPoll({ question: 'Next study-session topic? / 次の勉強会のテーマは？', options: topics }));
    const time = await postTopicPoll(deps, channelId, buildTopicPoll({ question: 'Which time works? / 都合の良い時間は？', options: slots.map((s) => s.label) }));
    return { topic, time, slots };
  }

  /** Winner, or the first listed option when votes tie or nobody voted. */
  function decide(kind: string, posted: PostedPoll, result: PollResult): string {
    if (result.winner) {
      monitor.logThought('Event', `Community chose ${kind}: ${result.winner}`);
      return result.winner;
    }
    const fallback = posted.poll.options[0].option;
    monitor.logThought('Event', `No clear winner for ${kind}; falling back to first option "${fallback}"`);
    return fallback;
  }

  async function planEvent(polls: EventPolls): Promise<EventPlan> {
    // 1. Ingest the community's votes.
    const topicResults = await collectPollResults(deps, polls.topic);
    const timeResults = await collectPollResults(deps, polls.time);

    // 2. Decide topic and time slot.
    const topic = decide('topic', polls.topic, topicResults);
    const slotLabel = decide('time', polls.time, timeResults);
    const slot = polls.slots.find((s) => s.label === slotLabel)!;

    // 3. Draft the Notion event page.
    monitor.logThought('Event', 'Drafting Notion event page', { title: eventTitle(topic) });
    const notionPage = buildNotionEventPage({ parentPageId, topic, slot, results: topicResults.results });

    monitor.logStatus('Event', `Event planned: ${topic} · ${slot.label}`);
    return { topic, slot, topicResults, timeResults, notionPage };
  }

  return { openPolls, planEvent };
}
