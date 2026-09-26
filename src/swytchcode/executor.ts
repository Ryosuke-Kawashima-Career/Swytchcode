// Swytchcode execution boundary. Live mode shells out to the `swytchcode exec` kernel
// (policy checks, managed provider auth, retries); mock mode answers in memory.
// Every call goes through `callTool`, which emits tool_call / tool_result telemetry.
import { spawn } from 'node:child_process';
import type { AppConfig } from '../config/env.ts';
import { SWYTCHCODE_TOOLS, type ToolAlias } from '../config/swytchcode_tools.ts';
import type { AgentMonitor, AgentName } from '../monitor/agent_monitor.ts';
import { MockToolExecutor } from './mock_executor.ts';

/** Tool inputs keyed by input name: `body`, path params, headers such as `Idempotency-Key`. */
export type ToolArgs = Record<string, unknown>;

export interface ToolExecutor {
  readonly mode: 'mock' | 'live';
  exec(tool: string, args: ToolArgs): Promise<unknown>;
}

export class SwytchcodeError extends Error {
  readonly tool: string;
  readonly exitCode: number | null;
  readonly category?: string;
  readonly suggestedAction?: string;

  constructor(tool: string, message: string, exitCode: number | null, category?: string, suggestedAction?: string) {
    super(message);
    this.name = 'SwytchcodeError';
    this.tool = tool;
    this.exitCode = exitCode;
    this.category = category;
    this.suggestedAction = suggestedAction;
  }
}

// ---------- CLI executor ----------

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CliRunner = (stdin: string) => Promise<CliResult>;

/** Runs `swytchcode exec --json` with the request on stdin (no payload on the command line). */
export const runSwyCli: CliRunner = (stdin) =>
  new Promise((resolve, reject) => {
    // `swytchcode` is an npm shim (.cmd) on Windows, which needs a shell; the command is a fixed string.
    const child =
      process.platform === 'win32'
        ? spawn('swytchcode exec --json', { shell: true, timeout: 120_000 })
        : spawn('swytchcode', ['exec', '--json'], { timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

/** The kernel may wrap a response in its return variable, e.g. {"resend_email_create": {...}}. */
function unwrapResponse(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] !== 'data' && entries[0][1] && typeof entries[0][1] === 'object') {
      return entries[0][1];
    }
  }
  return value;
}

/** The kernel prints its structured error as a single JSON line on stderr. */
function parseKernelError(stderr: string): { error?: string; category?: string; suggested_action?: string } {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{') && l.includes('"error"'));
  try {
    return line ? JSON.parse(line) : {};
  } catch {
    return {};
  }
}

export class SwyCliExecutor implements ToolExecutor {
  readonly mode = 'live';
  readonly #run: CliRunner;

  constructor({ run = runSwyCli }: { run?: CliRunner } = {}) {
    this.#run = run;
  }

  async exec(tool: string, args: ToolArgs): Promise<unknown> {
    const { code, stdout, stderr } = await this.#run(JSON.stringify({ tool, args }));

    if (code !== 0) {
      const kernel = parseKernelError(stderr);
      const message = kernel.error ?? (stderr.trim() || `swytchcode exec exited with code ${code}`);
      throw new SwytchcodeError(tool, message, code, kernel.category, kernel.suggested_action);
    }
    try {
      return unwrapResponse(JSON.parse(stdout));
    } catch {
      throw new SwytchcodeError(tool, `${tool} returned non-JSON output: ${stdout.slice(0, 200)}`, code);
    }
  }
}

export function createToolExecutor(config: AppConfig): ToolExecutor {
  return config.demoMode === 'live' ? new SwyCliExecutor() : new MockToolExecutor();
}

// ---------- instrumented call ----------

export interface ToolDeps {
  executor: ToolExecutor;
  monitor: AgentMonitor;
}

const preview = (value: unknown, max = 500) => {
  const json = JSON.stringify(value) ?? '';
  return json.length <= max ? json : `${json.slice(0, max - 1)}…`;
};

/** Executes a whitelisted tool by plan alias and reports it to the activity monitor. */
export async function callTool({ executor, monitor }: ToolDeps, agent: AgentName, alias: ToolAlias, args: ToolArgs): Promise<unknown> {
  const tool = SWYTCHCODE_TOOLS[alias];
  monitor.logToolCall(agent, `▶ ${tool}`, { alias, mode: executor.mode, args: preview(args) });

  const started = performance.now();
  const latencyMs = () => Math.round(performance.now() - started);
  try {
    const result = await executor.exec(tool, args);
    monitor.logToolResult(agent, `✔ ${tool} (${latencyMs()} ms)`, { latencyMs: latencyMs(), result: preview(result) });
    return result;
  } catch (error) {
    const err = error as Error & { category?: string };
    monitor.logError(agent, `✖ ${tool}: ${err.message}`, { latencyMs: latencyMs(), category: err.category });
    throw error;
  }
}
