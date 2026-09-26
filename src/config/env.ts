// Environment configuration. Mock mode is the default so the demo runs with zero credentials.

export type DemoMode = 'mock' | 'live';

/** Keys required for live mode. Every key must also appear in .env.example. */
export const ENV_KEYS = [
  'SWYTCHCODE_TOKEN',
  'NOTION_DATABASE_ID',
  'NOTION_PARENT_PAGE_ID',
  'NOTION_API_VERSION',
  'NOTION_SPONSOR_DATA_SOURCE_ID',
  'RESEND_FROM_EMAIL',
  'SPONSOR_REPORT_EMAIL',
  'DISCORD_BOT_TOKEN',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_GUILD_ID',
  'DISCORD_CHANNEL_GENERAL_ID',
  'DISCORD_CHANNEL_EVENTS_ID',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

export interface AppConfig {
  demoMode: DemoMode;
  port: number;
  env: Partial<Record<EnvKey, string>>;
  /** Live-mode keys that are unset; callers fall back to mock providers when non-empty. */
  missingLiveKeys: EnvKey[];
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  // 1. Resolve demo mode (default: mock) and reject typos early.
  const mode = source.DEMO_MODE ?? 'mock';
  if (mode !== 'mock' && mode !== 'live') {
    throw new Error(`DEMO_MODE must be "mock" or "live", got "${mode}"`);
  }

  // 2. Collect known keys and note which are missing for live mode.
  const env: Partial<Record<EnvKey, string>> = {};
  const missingLiveKeys: EnvKey[] = [];
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
    else missingLiveKeys.push(key);
  }

  return { demoMode: mode, port: Number(source.PORT ?? 3000), env, missingLiveKeys };
}
