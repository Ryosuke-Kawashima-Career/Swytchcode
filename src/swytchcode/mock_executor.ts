// In-memory stand-in for the Swytchcode kernel: realistic response shapes, no network.
// Keeps created pages and a demo sponsor CRM so closed-loop hand-offs are visible offline.
import type { ToolArgs, ToolExecutor } from './executor.ts';
import type { Sponsor } from '../agents/growth_agent.ts';

export const DEMO_SPONSORS: Sponsor[] = [
  { name: 'Priya Nair', email: 'priya.nair@example.com', company: 'Mumbai AI Labs' },
  { name: 'Kenji Sato', email: 'kenji.sato@example.com', company: 'Tokyo Cloud Works' },
  { name: 'Ananya Rao', email: 'ananya.rao@example.com', company: 'Bengaluru DevTools' },
];

export interface MockExecutorOptions {
  sponsors?: Sponsor[];
  /** Canonical tool ID -> error thrown whenever that tool runs. */
  failures?: Record<string, Error>;
  /** Recipients whose emails fail (simulates a Resend rejection). */
  failEmailTo?: string[];
}

export class MockToolExecutor implements ToolExecutor {
  readonly mode = 'mock';
  readonly calls: Array<{ tool: string; args: ToolArgs }> = [];
  readonly pages: Array<{ id: string; url: string }> = [];
  readonly #sponsors: Sponsor[];
  readonly #failures: Record<string, Error>;
  readonly #failEmailTo: Set<string>;
  #seq = 0;

  constructor({ sponsors = DEMO_SPONSORS, failures = {}, failEmailTo = [] }: MockExecutorOptions = {}) {
    this.#sponsors = sponsors;
    this.#failures = failures;
    this.#failEmailTo = new Set(failEmailTo);
  }

  async exec(tool: string, args: ToolArgs): Promise<unknown> {
    this.calls.push({ tool, args });
    if (this.#failures[tool]) throw this.#failures[tool];
    const n = ++this.#seq;

    switch (tool) {
      case 'notion.page.create': {
        const page = { id: `mock-page-${n}`, url: `https://www.notion.so/mock-page-${n}` };
        this.pages.push(page);
        return { object: 'page', ...page };
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
      case 'twitter_v2.tweet.create':
        return { data: { id: `mock-tweet-${n}`, text: (args.body as { text?: string })?.text ?? '' } };
      case 'resend.email.create': {
        // Resend accepts `to` as a single address or a list.
        const to = [(args.body as { to?: string | string[] })?.to ?? []].flat();
        if (to.some((addr) => this.#failEmailTo.has(addr))) throw new Error(`Resend rejected recipient ${to.join(', ')}`);
        return { id: `mock-email-${n}` };
      }
      default:
        throw new Error(`Tool "${tool}" is not whitelisted in tooling.json`);
    }
  }
}
