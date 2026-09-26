// Cross-Cultural Bridge agent (TASK-02 / REQ-01).
// Recognises Indo-Japanese cultural terms, translates the message, and attaches short
// context notes in the reader's language. Plugs into the Discord thread responder as its Annotator.
import type { AgentMonitor } from '../monitor/agent_monitor.ts';
import type { DiscordMessage, Lang } from '../discord/discord_client.ts';
import type { Annotation } from '../discord/thread_responder.ts';

/** Bridge replies are written for English (Indian members) or Japanese readers. */
export type NoteLang = 'en' | 'ja';

export interface CulturalEntity {
  id: string;
  name: string;
  kind: 'festival' | 'holiday' | 'honorific' | 'timezone';
  patterns: RegExp[];
  note: Record<NoteLang, string>;
}

// Latin-script aliases only match as whole words (so "Holi" never matches "Hollywood").
const word = (source: string, flags = 'iu') => new RegExp(`(?<!\\p{L})(?:${source})(?!\\p{L})`, flags);

export const CULTURAL_ENTITIES: CulturalEntity[] = [
  {
    id: 'diwali',
    name: 'Diwali',
    kind: 'festival',
    patterns: [word('diwali|deepavali'), /दिवाली|दीपावली|ディワリ|ディーワーリー/u],
    note: {
      en: 'Diwali (Deepavali) is India’s festival of lights, usually in October or November; families light lamps, share sweets, and many people take time off.',
      ja: 'ディワリ（ディーパバリ）はインドの「光の祭り」で、例年10〜11月頃。家々に灯りをともし、お菓子を贈り合い、休暇を取る人も多い大切な祝日です。',
    },
  },
  {
    id: 'holi',
    name: 'Holi',
    kind: 'festival',
    patterns: [word('holi'), /होली|ホーリー/u],
    note: {
      en: 'Holi is India’s spring festival of colours (February/March), celebrated by throwing coloured powder and water.',
      ja: 'ホーリーは2〜3月頃のインドの春祭り「色の祭り」で、色粉や色水をかけ合って祝います。',
    },
  },
  {
    id: 'republic-day',
    name: 'Republic Day',
    kind: 'holiday',
    patterns: [word('republic day'), /गणतंत्र दिवस/u],
    note: {
      en: 'Republic Day (26 January) is an Indian national holiday marking the adoption of the constitution.',
      ja: 'リパブリック・デー（共和国記念日、1月26日）はインド憲法の施行を記念する国民の祝日です。',
    },
  },
  {
    id: 'obon',
    name: 'Obon',
    kind: 'festival',
    patterns: [word('obon|bon festival'), /お盆/u],
    note: {
      en: 'Obon is a Japanese Buddhist custom in mid-August honouring ancestors; many people travel to their hometowns and some offices close.',
      ja: 'お盆は8月中旬に先祖の霊を迎える日本の行事で、帰省する人が多く、会社が休みになることもあります。',
    },
  },
  {
    id: 'golden-week',
    name: 'Golden Week',
    kind: 'holiday',
    patterns: [word('golden week'), /ゴールデンウィーク/u],
    note: {
      en: 'Golden Week is a run of Japanese public holidays from late April to early May — expect slower replies and busy travel.',
      ja: 'ゴールデンウィークは4月末〜5月初めの日本の連休です。返信が遅くなったり、移動が混雑したりします。',
    },
  },
  {
    id: 'hanami',
    name: 'Hanami',
    kind: 'festival',
    patterns: [word('hanami|cherry[- ]blossom viewing'), /花見/u],
    note: {
      en: 'Hanami is the Japanese custom of cherry-blossom viewing picnics in late March to early April.',
      ja: '花見（お花見）は3月下旬〜4月上旬に桜を楽しむ日本の習慣です。',
    },
  },
  {
    id: 'shogatsu',
    name: 'Shōgatsu',
    kind: 'holiday',
    patterns: [word('sh[oō]gatsu|japanese new year'), /正月/u],
    note: {
      en: 'Shōgatsu is Japanese New Year (1–3 January), the most important holiday in Japan; most businesses close.',
      ja: '正月は1月1日〜3日頃の日本で最も大切な祝日で、多くの会社が休みになります。',
    },
  },
  {
    id: 'honorific-san',
    name: '-san',
    kind: 'honorific',
    patterns: [word('\\p{L}+-san'), /さん/u],
    note: {
      en: '“-san” is a polite Japanese honorific added to names, similar to Mr./Ms.; it is never used for yourself.',
      ja: '「さん」は名前につける日本語の敬称で、英語の Mr./Ms. に近い表現です。',
    },
  },
  {
    id: 'honorific-ji',
    name: '-ji',
    kind: 'honorific',
    patterns: [word('\\p{L}+-ji'), /जी/u],
    note: {
      en: '“-ji” is a respectful Hindi suffix added to names or titles (e.g. Sharma-ji), showing warmth and respect.',
      ja: '「-ji（ジー）」はヒンディー語で名前や肩書きにつける敬意を表す接尾語です（例: Sharma-ji）。日本語の「さん」に近い表現です。',
    },
  },
  {
    id: 'senpai',
    name: 'Senpai',
    kind: 'honorific',
    patterns: [word('senpai|sempai'), /先輩/u],
    note: {
      en: 'Senpai (先輩) means a senior colleague or schoolmate; the relationship carries mentoring expectations.',
      ja: '先輩は職場や学校の年長者・経験者を指し、後輩を指導する役割が期待されます。',
    },
  },
  {
    id: 'timezone-ist',
    name: 'IST',
    kind: 'timezone',
    patterns: [word('IST', 'u')], // case-sensitive: avoid matching the word "ist"
    note: {
      en: 'IST (India Standard Time) is UTC+5:30 — 3½ hours behind Japan.',
      ja: 'IST（インド標準時）はUTC+5:30で、日本より3時間30分遅れています。',
    },
  },
  {
    id: 'timezone-jst',
    name: 'JST',
    kind: 'timezone',
    patterns: [word('JST', 'u')],
    note: {
      en: 'JST (Japan Standard Time) is UTC+9 — 3½ hours ahead of India.',
      ja: 'JST（日本標準時）はUTC+9で、インドより3時間30分進んでいます。',
    },
  },
];

/** Entities mentioned in `text`, each once, ordered by first appearance. */
export function recognizeEntities(text: string): CulturalEntity[] {
  return CULTURAL_ENTITIES.map((entity) => {
    const positions = entity.patterns.map((re) => text.search(re)).filter((i) => i >= 0);
    return { entity, index: positions.length ? Math.min(...positions) : -1 };
  })
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(({ entity }) => entity);
}

/** Japanese and Hindi posts are bridged to English; English posts to Japanese. */
export function targetLanguageFor(lang: Lang): NoteLang {
  return lang === 'en' ? 'ja' : 'en';
}

// ---------- translation ----------

export type Translator = (text: string, from: Lang, to: Lang) => Promise<string>;

export type PhrasebookEntry = Partial<Record<Lang, string>>;

/** Offline translator for mock mode: exact-match phrasebook, clearly marked fallback otherwise. */
export function createPhrasebookTranslator(entries: PhrasebookEntry[]): Translator {
  return async (text, from, to) => {
    const source = text.trim();
    const hit = entries.find((e) => e[from] === source)?.[to];
    return hit ?? `[${from}→${to} machine translation unavailable offline] ${source}`;
  };
}

/** Sentences used by the scripted demo. */
export const DEMO_PHRASEBOOK: PhrasebookEntry[] = [
  { ja: 'お盆休みはいつですか？', en: 'When is the Obon holiday?' },
  { hi: 'दिवाली की शुभकामनाएं', en: 'Happy Diwali' },
  { en: 'Diwali meetup next week!', ja: '来週ディワリのミートアップをします！' },
  { ja: '田中さんがゴールデンウィーク明けに勉強会を開きます。', en: 'Tanaka-san will host a study session after Golden Week.' },
];

// ---------- annotator ----------

export interface BridgeAgentOptions {
  monitor: AgentMonitor;
  translate: Translator;
}

export function createBridgeAgent({ monitor, translate }: BridgeAgentOptions) {
  async function annotate(message: DiscordMessage, lang: Lang): Promise<Annotation | null> {
    // 1. Spot cultural terms that a reader from the other country may not know.
    const entities = recognizeEntities(message.content);
    if (entities.length > 0) {
      monitor.logThought('Bridge', `Detected cultural terms: ${entities.map((e) => e.name).join(', ')}`, {
        kinds: entities.map((e) => e.kind),
      });
    }

    // 2. Plain English with nothing to explain is readable by everyone: no reply.
    if (lang === 'en' && entities.length === 0) {
      monitor.logThought('Bridge', 'Plain English with no cultural terms: no bridge needed');
      return null;
    }

    // 3. Translate for the other community and attach notes in that language.
    const targetLang = targetLanguageFor(lang);
    monitor.logThought('Bridge', `Translating ${lang} → ${targetLang}`, { messageId: message.id });
    const translation = await translate(message.content, lang, targetLang);

    return { translation, targetLang, notes: entities.map((e) => e.note[targetLang]) };
  }

  return { annotate };
}
