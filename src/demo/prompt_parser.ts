// Rule-based parser for the demo's natural-language request box.
// Extracts the event date (India calendar) and candidate poll topics.

export interface PipelineInput {
  date: string; // YYYY-MM-DD
  topics: string[];
}

const DEFAULT_TOPICS = ['AI Agents', 'RAG', 'Evals'];
const MAX_TOPICS = 5;

/** Catalog order decides topic order when topics are inferred from free text. */
const TOPIC_CATALOG: Array<[string, RegExp]> = [
  ['AI Agents', /\bagent(s|ic)?\b/i],
  ['RAG', /\b(rag|retrieval)\b/i],
  ['Evals', /\bevals?\b|\bevaluations?\b/i],
  ['LLMOps', /\b(llm|ml)ops\b/i],
  ['Voice AI', /\bvoice\b/i],
  ['Computer Vision', /\b(computer vision|vision)\b/i],
  ['Robotics', /\brobot(s|ics)?\b/i],
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const IST_OFFSET_MS = 330 * 60_000;

function parseTopics(text: string): string[] {
  // 1. An explicit "Topics: a, b, c" list wins.
  const explicit = text.match(/topics?\s*:\s*([^\n.]+)/i);
  if (explicit) {
    // The list ends at a follow-up instruction ("…, then publish it in Notion").
    const [items] = explicit[1].split(/\b(?:and\s+)?then\b/i);
    const list = items.split(/,|\/|;|\bor\b/i).map((t) => t.trim()).filter(Boolean);
    if (list.length >= 2) return list.slice(0, MAX_TOPICS);
  }

  // 2. Otherwise infer from known topics; pad with defaults so a poll has options.
  const found = TOPIC_CATALOG.filter(([, re]) => re.test(text)).map(([name]) => name);
  const topics = found.length >= 2 ? found : [...new Set([...found, ...DEFAULT_TOPICS])].slice(0, 3);
  return topics.slice(0, MAX_TOPICS);
}

function parseDate(text: string, now: Date): string {
  // "Today" is the India calendar date (events are scheduled on the IST day).
  const today = new Date(now.getTime() + IST_OFFSET_MS);
  today.setUTCHours(0, 0, 0, 0);
  const addDays = (n: number) => new Date(today.getTime() + n * 86_400_000).toISOString().slice(0, 10);

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && !Number.isNaN(Date.parse(iso[1]))) return iso[1];
  if (/\btomorrow\b/i.test(text)) return addDays(1);

  // Named weekday (or Saturday by default): the next occurrence strictly after today.
  const named = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`, 'i').test(text));
  const target = named >= 0 ? named : 6;
  const delta = (target - today.getUTCDay() + 7) % 7 || 7;
  return addDays(delta);
}

export function parsePrompt(text: string, now: Date = new Date()): PipelineInput {
  return { date: parseDate(text, now), topics: parseTopics(text) };
}
