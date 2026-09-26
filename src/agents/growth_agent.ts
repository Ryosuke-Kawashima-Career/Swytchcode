// Growth & Sponsor Outreach agent (TASK-04 / REQ-03).
// Closed loop: Notion event page -> bilingual X post (links the page) ->
// sponsor list from the Notion CRM -> personalised Resend emails (link page + post).
import type { AgentMonitor } from '../monitor/agent_monitor.ts';
import { callTool, type ToolExecutor } from '../swytchcode/executor.ts';
import type { TimeSlot } from './event_agent.ts';

export interface Sponsor {
  name: string;
  email: string;
  company: string;
}

export interface NotionPageRef {
  id: string;
  url: string;
}

// ---------- X post ----------

export const HASHTAGS = '#Antigravity #IndoJapanTech';
const TWEET_LIMIT = 280;
const URL_WEIGHT = 23; // X shortens every link to t.co

/** X's weighted length: URLs count 23, Latin/general punctuation 1, everything else (CJK, emoji) 2. */
export function tweetLength(text: string): number {
  let length = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    length += URL_WEIGHT;
    return '';
  });
  for (const char of withoutUrls) {
    const cp = char.codePointAt(0)!;
    const light = cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    length += light ? 1 : 2;
  }
  return length;
}

export function buildTweet({ topic, slot, pageUrl }: { topic: string; slot: TimeSlot; pageUrl: string }): { text: string } {
  const compose = (t: string) =>
    [`🇮🇳🤝🇯🇵 Antigravity Fan Club study session: ${t}`, `次回の勉強会: ${t}`, `🗓 ${slot.label}`, pageUrl, HASHTAGS].join('\n');

  // Shorten the topic (it appears twice) until the post fits.
  let shown = topic.trim();
  while (tweetLength(compose(shown)) > TWEET_LIMIT && shown.length > 1) {
    shown = `${shown.slice(0, Math.max(1, shown.length - 6)).trimEnd()}…`;
  }
  return { text: compose(shown) };
}

export const tweetUrl = (id: string) => `https://x.com/i/web/status/${id}`;

// ---------- sponsor email ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface SponsorEmailInput {
  sponsor: Sponsor;
  topic: string;
  slot: TimeSlot;
  pageUrl: string;
  tweetUrl: string;
  from: string;
}

/** Request body for Swytchcode `resend.email.create`. */
export function buildSponsorEmail({ sponsor, topic, slot, pageUrl, tweetUrl, from }: SponsorEmailInput) {
  const paragraphs = [
    `Dear ${sponsor.name},`,
    `The Antigravity Fan Club, a bilingual community of Japanese and Indian developers, is hosting a study session on ${topic}.`,
    `When: ${slot.ist} / ${slot.jst}`,
    `Event page: ${pageUrl}`,
    `Announcement: ${tweetUrl}`,
    `We would love ${sponsor.company} to join as a sponsor and reach engineers in both countries. Just reply to this email if you are interested.`,
    'Warm regards,\nAI Community Organizer, on behalf of the Antigravity Fan Club',
  ];
  return {
    from,
    to: [sponsor.email],
    subject: `Sponsorship invitation: ${topic} study session (India × Japan)`,
    text: paragraphs.join('\n\n'),
    html: paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n'),
  };
}

// ---------- sponsor CRM ingestion ----------

type NotionProperty = {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  email?: string | null;
  select?: { name?: string } | null;
};

const plain = (parts?: Array<{ plain_text?: string }>) => (parts ?? []).map((p) => p.plain_text ?? '').join('').trim();

/** Maps a Notion data-source query to sponsors: title -> name, email -> email, "Company" -> company. */
export function parseSponsorRows(response: unknown): Sponsor[] {
  const rows = (response as { results?: Array<{ properties?: Record<string, NotionProperty> }> })?.results ?? [];
  return rows.flatMap(({ properties = {} }) => {
    const props = Object.entries(properties);
    const name = plain(props.find(([, p]) => p.type === 'title')?.[1].title);
    const email = props.find(([, p]) => p.type === 'email')?.[1].email;
    const company = properties.Company;
    const companyName = plain(company?.rich_text) || plain(company?.title) || company?.select?.name || name;
    return email ? [{ name, email, company: companyName }] : [];
  });
}

// ---------- agent ----------

export interface GrowthAgentOptions {
  executor: ToolExecutor;
  monitor: AgentMonitor;
  fromEmail: string;
  sponsorDataSourceId: string;
  notionVersion?: string;
}

export interface EmailOutcome {
  to: string;
  status: 'sent' | 'failed';
  id?: string;
  error?: string;
}

export interface GrowthOutcome {
  tweet: { id: string; url: string; text: string };
  sponsors: Sponsor[];
  emails: EmailOutcome[];
}

export function createGrowthAgent({ executor, monitor, fromEmail, sponsorDataSourceId, notionVersion }: GrowthAgentOptions) {
  const deps = { executor, monitor };

  async function promote({ topic, slot, page }: { topic: string; slot: TimeSlot; page: NotionPageRef }): Promise<GrowthOutcome> {
    // 1. Notion page -> X post.
    monitor.logThought('Growth', 'Drafting bilingual X post that links the Notion event page', { pageUrl: page.url });
    const { text } = buildTweet({ topic, slot, pageUrl: page.url });
    const posted = (await callTool(deps, 'Growth', 'x.create_tweet', { body: { text } })) as { data?: { id?: string }; id?: string };
    const id = posted.data?.id ?? posted.id ?? '';
    const tweet = { id, url: tweetUrl(id), text };

    // 2. Ingest the sponsor CRM from Notion.
    monitor.logThought('Growth', 'Looking up sponsor contacts in the Notion CRM');
    const query = await callTool(deps, 'Growth', 'notion.query_database', {
      data_source_id: sponsorDataSourceId,
      body: { page_size: 50 },
      ...(notionVersion && { 'Notion-Version': notionVersion }),
    });
    const sponsors = parseSponsorRows(query);
    monitor.logThought('Growth', `Found ${sponsors.length} sponsors: ${sponsors.map((s) => s.company).join(', ')}`);

    // 3. Personalised email per sponsor. One failure must not stop the rest;
    //    the idempotency key keeps agent retries from sending duplicates.
    const emails: EmailOutcome[] = [];
    for (const sponsor of sponsors) {
      const body = buildSponsorEmail({ sponsor, topic, slot, pageUrl: page.url, tweetUrl: tweet.url, from: fromEmail });
      try {
        const sent = (await callTool(deps, 'Growth', 'resend.send_email', {
          body,
          'Idempotency-Key': `sponsor-invite:${page.id}:${sponsor.email}`,
        })) as { id?: string };
        emails.push({ to: sponsor.email, status: 'sent', id: sent.id });
      } catch (error) {
        emails.push({ to: sponsor.email, status: 'failed', error: (error as Error).message });
      }
    }

    const sent = emails.filter((e) => e.status === 'sent').length;
    monitor.logStatus('Growth', `Outreach done: X post live, ${sent}/${sponsors.length} sponsor emails sent`);
    return { tweet, sponsors, emails };
  }

  return { promote };
}
