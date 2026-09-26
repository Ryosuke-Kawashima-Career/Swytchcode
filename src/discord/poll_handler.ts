// Emoji-reaction topic polls: build, post (bot seeds one reaction per option), and tally.
import type { AgentMonitor } from '../monitor/agent_monitor.ts';
import { EMBED_COLOR, type DiscordTransport, type OutgoingMessage, type ReactionCount } from './discord_client.ts';

export const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export interface TopicPoll {
  question: string;
  options: Array<{ option: string; emoji: string }>;
  message: OutgoingMessage;
}

export interface PostedPoll {
  channelId: string;
  messageId: string;
  poll: TopicPoll;
}

export interface PollResult {
  results: Array<{ option: string; emoji: string; votes: number }>;
  /** Null on a tie for first place or when nobody voted. */
  winner: string | null;
  totalVotes: number;
}

export interface DiscordDeps {
  transport: DiscordTransport;
  monitor: AgentMonitor;
}

export function buildTopicPoll({ question, options }: { question: string; options: string[] }): TopicPoll {
  if (options.length < 2 || options.length > POLL_EMOJIS.length) {
    throw new Error(`A poll needs 2-10 options, got ${options.length}`);
  }
  const entries = options.map((option, i) => ({ option, emoji: POLL_EMOJIS[i] }));
  return {
    question,
    options: entries,
    message: {
      embeds: [
        {
          title: `📊 ${question}`,
          description: entries.map((e) => `${e.emoji} ${e.option}`).join('\n'),
          color: EMBED_COLOR,
          footer: { text: 'React to vote · 投票はリアクションで · प्रतिक्रिया देकर वोट करें' },
        },
      ],
    },
  };
}

/** Pure tally: subtracts the bot's own seed reaction and ignores non-option emojis. */
export function tallyVotes(poll: TopicPoll, reactions: ReactionCount[]): PollResult {
  // 1. Count human votes per option.
  const results = poll.options.map(({ option, emoji }) => {
    const reaction = reactions.find((r) => r.emoji === emoji);
    const votes = reaction ? Math.max(0, reaction.count - (reaction.me ? 1 : 0)) : 0;
    return { option, emoji, votes };
  });

  // 2. Rank (stable sort keeps option order among equals) and detect a clear winner.
  results.sort((a, b) => b.votes - a.votes);
  const [first, second] = results;
  const winner = first.votes > 0 && first.votes !== second?.votes ? first.option : null;

  return { results, winner, totalVotes: results.reduce((sum, r) => sum + r.votes, 0) };
}

export async function postTopicPoll({ transport, monitor }: DiscordDeps, channelId: string, poll: TopicPoll): Promise<PostedPoll> {
  monitor.logToolCall('Discord', `Posting topic poll "${poll.question}"`, {
    channelId,
    options: poll.options.map((o) => o.option),
  });

  const sent = await transport.sendMessage(channelId, poll.message);
  // Sequential on purpose: Discord rate-limits reactions per message, and order matters for display.
  for (const { emoji } of poll.options) await transport.addReaction(channelId, sent.id, emoji);

  monitor.logToolResult('Discord', `Poll posted with ${poll.options.length} options`, { messageId: sent.id });
  return { channelId, messageId: sent.id, poll };
}

export async function collectPollResults({ transport, monitor }: DiscordDeps, posted: PostedPoll): Promise<PollResult> {
  monitor.logToolCall('Discord', `Collecting votes for "${posted.poll.question}"`, { messageId: posted.messageId });

  const result = tallyVotes(posted.poll, await transport.getReactions(posted.channelId, posted.messageId));

  monitor.logToolResult('Discord', result.winner ? `Poll winner: ${result.winner} (${result.totalVotes} votes)` : 'Poll has no clear winner', {
    results: result.results,
  });
  return result;
}
