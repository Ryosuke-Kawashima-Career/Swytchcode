// Color-coded CLI mirror of the agent activity stream.
import type { ActivityType, AgentActivityEvent, AgentMonitor } from './agent_monitor.ts';

const COLORS: Record<ActivityType, number> = {
  thought: 36, // cyan
  tool_call: 33, // yellow
  tool_result: 32, // green
  error: 31, // red
  status: 35, // magenta
};

const TYPE_WIDTH = 12; // longest type ("tool_result", 11) plus one space before the summary

export interface PrinterOptions {
  color?: boolean;
  write?: (line: string) => void;
}

/** `HH:MM:SS [Agent] type  summary` (UTC time taken from the ISO timestamp). */
export function formatConsoleLine(event: AgentActivityEvent, { color = true }: PrinterOptions = {}): string {
  const time = event.timestamp.slice(11, 19);
  const type = event.type.padEnd(TYPE_WIDTH);
  const label = color ? `\x1b[${COLORS[event.type]}m${type}\x1b[0m` : type;
  return `${time} [${event.agent}] ${label}${event.summary}`;
}

/** Prints every monitor event; returns a detach function. */
export function attachConsolePrinter(
  monitor: AgentMonitor,
  { color = !process.env.NO_COLOR, write = (line) => console.log(line) }: PrinterOptions = {},
): () => void {
  return monitor.subscribe((event) => write(formatConsoleLine(event, { color })));
}
