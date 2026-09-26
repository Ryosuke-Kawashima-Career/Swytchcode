// Minimal Agent Activity Monitor (TASK-07 / REQ-06).
// In-memory event bus: agents log activity, subscribers (console, SSE) receive it,
// and a ring buffer of recent events hydrates newly opened demo UI tabs.
import { EventEmitter } from 'node:events';

export type AgentName = 'Supervisor' | 'Bridge' | 'Event' | 'Growth' | 'Discord';
export type ActivityType = 'thought' | 'tool_call' | 'tool_result' | 'error' | 'status';

export interface AgentActivityEvent {
  timestamp: string; // ISO 8601
  agent: AgentName;
  type: ActivityType;
  summary: string; // 1-line human-readable description for judges
  details?: Record<string, unknown>;
}

export type ActivityListener = (event: AgentActivityEvent) => void;

export interface AgentMonitorOptions {
  /** Ring buffer size (default 100). */
  capacity?: number;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

const ACTIVITY = 'activity';

export class AgentMonitor extends EventEmitter {
  readonly #capacity: number;
  readonly #now: () => Date;
  readonly #buffer: AgentActivityEvent[] = [];
  #head = 0; // index of the oldest event once the buffer is full

  constructor({ capacity = 100, now = () => new Date() }: AgentMonitorOptions = {}) {
    super();
    this.#capacity = capacity;
    this.#now = now;
    this.setMaxListeners(100); // one listener per SSE client; the warning still catches real leaks
  }

  logThought(agent: AgentName, summary: string, details?: Record<string, unknown>) {
    return this.#log(agent, 'thought', summary, details);
  }

  logToolCall(agent: AgentName, summary: string, details?: Record<string, unknown>) {
    return this.#log(agent, 'tool_call', summary, details);
  }

  logToolResult(agent: AgentName, summary: string, details?: Record<string, unknown>) {
    return this.#log(agent, 'tool_result', summary, details);
  }

  logStatus(agent: AgentName, summary: string, details?: Record<string, unknown>) {
    return this.#log(agent, 'status', summary, details);
  }

  logError(agent: AgentName, summary: string, details?: Record<string, unknown>) {
    return this.#log(agent, 'error', summary, details);
  }

  /** Registers a listener and returns its unsubscribe function. */
  subscribe(listener: ActivityListener): () => void {
    this.on(ACTIVITY, listener);
    return () => this.off(ACTIVITY, listener);
  }

  subscriberCount(): number {
    return this.listenerCount(ACTIVITY);
  }

  /** Recent events, oldest first. Returns a copy. */
  history(): AgentActivityEvent[] {
    return [...this.#buffer.slice(this.#head), ...this.#buffer.slice(0, this.#head)];
  }

  #log(agent: AgentName, type: ActivityType, summary: string, details?: Record<string, unknown>) {
    // 1. Build the event; omit `details` entirely when absent to keep payloads small.
    const event: AgentActivityEvent = { timestamp: this.#now().toISOString(), agent, type, summary };
    if (details) event.details = details;

    // 2. Append to the ring buffer: grow until full, then overwrite the oldest slot.
    if (this.#buffer.length < this.#capacity) {
      this.#buffer.push(event);
    } else {
      this.#buffer[this.#head] = event;
      this.#head = (this.#head + 1) % this.#capacity;
    }

    // 3. Fan out to subscribers.
    this.emit(ACTIVITY, event);
    return event;
  }
}

/** Shared process-wide monitor used by agents, the console printer and the SSE route. */
export const monitor = new AgentMonitor();
