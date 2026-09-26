// Phase 1 (TASK-01) contract: project skeleton, Swytchcode trust boundary, env template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SWYTCHCODE_TOOLS, REQUIRED_INTEGRATIONS } from '../src/config/swytchcode_tools.ts';
import { ENV_KEYS, loadConfig } from '../src/config/env.ts';

const root = join(import.meta.dirname, '..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

test('project skeleton directories exist', () => {
  for (const dir of ['src', 'tests']) assert.ok(existsSync(join(root, dir)), `${dir}/ missing`);
});

test('package.json declares ESM and the plan verification scripts', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.type, 'module');
  for (const script of ['test', 'test:monitor', 'test:discord', 'demo:simulate', 'dev', 'typecheck']) {
    assert.ok(pkg.scripts?.[script], `missing npm script "${script}"`);
  }
});

test('tsconfig.json is strict and type-check only', () => {
  const { compilerOptions } = readJson('tsconfig.json');
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.noEmit, true);
});

test('tooling.json registers the Notion, Resend and Twitter integrations', () => {
  const tooling = readJson('.swytchcode/tooling.json');
  for (const key of REQUIRED_INTEGRATIONS) {
    assert.ok(tooling.integrations?.[key], `integration "${key}" not registered in tooling.json`);
  }
});

test('plan tool aliases map to Swytchcode canonical IDs', () => {
  assert.deepEqual(Object.keys(SWYTCHCODE_TOOLS).sort(), [
    'notion.create_page',
    'notion.query_database',
    'resend.send_email',
    'x.create_tweet',
  ]);
  assert.equal(SWYTCHCODE_TOOLS['notion.create_page'], 'notion.page.create');
  assert.equal(SWYTCHCODE_TOOLS['notion.query_database'], 'notion.query.create');
  assert.equal(SWYTCHCODE_TOOLS['resend.send_email'], 'resend.email.create');
  assert.equal(SWYTCHCODE_TOOLS['x.create_tweet'], 'twitter_v2.tweet.create');
});

test('tooling.json whitelists every canonical tool', () => {
  const tooling = readJson('.swytchcode/tooling.json');
  for (const id of Object.values(SWYTCHCODE_TOOLS)) {
    assert.ok(tooling.tools?.[id], `tool "${id}" not whitelisted`);
  }
});

test('.env.example documents every key the config reads', () => {
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  const declared = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  for (const key of ENV_KEYS) assert.ok(declared.has(key), `.env.example missing ${key}`);
});

test('.env.example contains no real secrets', () => {
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  assert.doesNotMatch(example, /swy_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{8,}|ntn_[A-Za-z0-9]{8,}|secret_[A-Za-z0-9]{8,}/);
});

test('loadConfig defaults to mock mode with an empty environment', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.demoMode, 'mock');
  assert.equal(cfg.port, 3000);
  assert.ok(cfg.missingLiveKeys.length > 0);
});

test('loadConfig reports no missing keys when live credentials are present', () => {
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, 'x']));
  const cfg = loadConfig({ ...env, DEMO_MODE: 'live', PORT: '4321' });
  assert.equal(cfg.demoMode, 'live');
  assert.equal(cfg.port, 4321);
  assert.deepEqual(cfg.missingLiveKeys, []);
});

test('loadConfig rejects an unknown DEMO_MODE', () => {
  assert.throws(() => loadConfig({ DEMO_MODE: 'staging' }), /DEMO_MODE/);
});
