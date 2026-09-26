// Server-Sent Events route (GET /api/events) streaming AgentMonitor activity to browsers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentActivityEvent, AgentMonitor } from './agent_monitor.ts';

/** JSON.stringify escapes newlines, so each event is exactly one `data:` line. */
export function toSseFrame(event: AgentActivityEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function createSseHandler(monitor: AgentMonitor) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // 1. Open the stream.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 2. Hydrate the new client with recent history, then stream live events.
    for (const event of monitor.history()) res.write(toSseFrame(event));
    const unsubscribe = monitor.subscribe((event) => res.write(toSseFrame(event)));

    // 3. Drop the listener when the client disconnects so listeners never leak.
    req.on('close', unsubscribe);
  };
}
