// In-memory stand-in for the Swytchcode kernel: realistic response shapes, no network.
// Keeps created pages/posts (viewable via the demo server's /mock routes) and a demo
// sponsor CRM so closed-loop hand-offs are visible offline.
import type { ToolArgs, ToolExecutor } from './executor.ts';
import type { Sponsor } from '../agents/growth_agent.ts';

export const DEMO_SPONSORS: Sponsor[] = [
  { name: 'Priya Nair', email: 'priya.nair@example.com', company: 'Mumbai AI Labs' },
  { name: 'Kenji Sato', email: 'kenji.sato@example.com', company: 'Tokyo Cloud Works' },
  { name: 'Ananya Rao', email: 'ananya.rao@example.com', company: 'Bengaluru DevTools' },
];

export interface MockPage {
  id: string;
  url: string;
  title: string;
  /** The `notion.page.create` request body, rendered by the mock page view. */
  body: unknown;
  createdAt: string;
}

export interface MockTweet {
  id: string;
  url: string;
  text: string;
  createdAt: string;
}

/** Artifacts created by mock tool calls. Share one store across runs so IDs stay unique. */
export class MockArtifactStore {
  readonly pages = new Map<string, MockPage>();
  readonly tweets = new Map<string, MockTweet>();
  #seq = 0;

  nextId(prefix: string): string {
    return `${prefix}-${++this.#seq}`;
  }
}

const pageTitle = (body: unknown) =>
  (body as { properties?: { title?: { title?: Array<{ text?: { content?: string } }> } } })?.properties?.title?.title?.[0]?.text
    ?.content ?? 'Untitled';

export interface MockExecutorOptions {
  sponsors?: Sponsor[];
  store?: MockArtifactStore;
  /** Demo server origin; when set, page/post URLs point at its /mock views instead of dead links. */
  baseUrl?: string;
  /** Canonical tool ID -> error thrown whenever that tool runs. */
  failures?: Record<string, Error>;
  /** Recipients whose emails fail (simulates a Resend rejection). */
  failEmailTo?: string[];
  /** Artificial delay per call so the live demo feed is watchable. */
  latencyMs?: number;
}

export class MockToolExecutor implements ToolExecutor {
  readonly mode = 'mock';
  readonly calls: Array<{ tool: string; args: ToolArgs }> = [];
  readonly store: MockArtifactStore;
  readonly #baseUrl?: string;
  readonly #sponsors: Sponsor[];
  readonly #failures: Record<string, Error>;
  readonly #failEmailTo: Set<string>;
  readonly #latencyMs: number;

  constructor({
    sponsors = DEMO_SPONSORS,
    store = new MockArtifactStore(),
    baseUrl,
    failures = {},
    failEmailTo = [],
    latencyMs = 0,
  }: MockExecutorOptions = {}) {
    this.store = store;
    this.#baseUrl = baseUrl;
    this.#sponsors = sponsors;
    this.#failures = failures;
    this.#failEmailTo = new Set(failEmailTo);
    this.#latencyMs = latencyMs;
  }

  /** Pages created through this executor's store, oldest first. */
  get pages(): MockPage[] {
    return [...this.store.pages.values()];
  }

  async exec(tool: string, args: ToolArgs): Promise<unknown> {
    this.calls.push({ tool, args });
    if (this.#latencyMs > 0) await new Promise((r) => setTimeout(r, this.#latencyMs));
    if (this.#failures[tool]) throw this.#failures[tool];
    const createdAt = new Date().toISOString();

    switch (tool) {
      case 'notion.page.create': {
        const id = this.store.nextId('mock-page');
        const url = this.#baseUrl ? `${this.#baseUrl}/mock/notion/${id}` : `https://www.notion.so/${id}`;
        this.store.pages.set(id, { id, url, title: pageTitle(args.body), body: args.body, createdAt });
        return { object: 'page', id, url };
      }
      case 'notion.query.create':
        return {
          object: 'list',
          results: this.#sponsors.map((s) => ({
            object: 'page',
            properties: {
              Name: { type: 'title', title: [{ plain_text: s.name }] },
              Email: { type: 'email', email: s.email },
              Company: { type: 'rich_text', rich_text: [{ plain_text: s.company }] },
            },
          })),
        };
      case 'twitter_v2.tweet.create': {
        const id = this.store.nextId('mock-tweet');
        const text = (args.body as { text?: string })?.text ?? '';
        // `url` is mock-only (the X API returns just data.id); the growth agent prefers it when present.
        const url = this.#baseUrl ? `${this.#baseUrl}/mock/x/${id}` : undefined;
        if (url) this.store.tweets.set(id, { id, url, text, createdAt });
        return { data: { id, text }, ...(url && { url }) };
      }
      case 'resend.email.create': {
        // Resend accepts `to` as a single address or a list.
        const to = [(args.body as { to?: string | string[] })?.to ?? []].flat();
        if (to.some((addr) => this.#failEmailTo.has(addr))) throw new Error(`Resend rejected recipient ${to.join(', ')}`);
        return { id: this.store.nextId('mock-email') };
      }
      default:
        throw new Error(`Tool "${tool}" is not whitelisted in tooling.json`);
    }
  }
}
