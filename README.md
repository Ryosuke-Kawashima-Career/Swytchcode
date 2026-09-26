# AI Community Organizer Agent

### Autonomous Multi-Agent Community Operations Platform for Discord, Notion, X, and Resend

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D23.6-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9_Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-99%20Passing-brightgreen?style=flat-square)](tests/)
[![Architecture](https://img.shields.io/badge/Architecture-Multi--Agent%20%2F%20SSE-6B46C1?style=flat-square)](dev/specs/spec_community_agents.md)
[![Tooling](https://img.shields.io/badge/Swytchcode-Notion%20%7C%20X%20%7C%20Resend-FF6B6B?style=flat-square)](.swytchcode/tooling.json)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

---

## Executive Resume and Project Summary

The **AI Community Organizer Agent** is an autonomous multi-agent system designed for international developer organizations operating cross-border communities across multiple time zones and languages. Specifically engineered for the Antigravity Fan Club bridging Japan and India, the platform solves core operational challenges: cross-cultural language barriers, organizer burnout in event scheduling across IST and JST, multi-channel marketing, and sponsor relationship management.

By orchestrating Discord community interactions with Swytchcode tool contracts (`notion.page.create`, `notion.query.create`, `twitter_v2.tweet.create`, and `resend.email.create`), the agent performs closed-loop community operations. Real-time agent decisions, tool invocations, and execution metrics are streamed through a lightweight, zero-dependency in-memory `AgentMonitor` observable via CLI and Server-Sent Events (SSE).

### Technical Highlights

- **Multi-Agent Decoupled Architecture**: Coordinated by an overarching Supervisor, specialized agents handle cultural translation, event scheduling consensus, and outbound marketing pipelines.
- **Cross-Cultural Bridge Engine**: Script detection (Japanese Kanji/Kana, Hindi Devanagari, English Latin), entity recognition for holidays and festivals (Diwali, Obon, Golden Week), and bilingual cultural nuance annotations.
- **Closed-Loop Data Handoff**: Community voting tallies on Discord automatically feed into Notion event page creation, which triggers promotional social broadcasts on X and personalized sponsor pitches via Resend.
- **Resilient Dual Execution Mode**: Full support for live external credentials as well as zero-credential local mock execution (`DEMO_MODE=mock`) with 100% test coverage and offline reliability.
- **Zero-Dependency Observability**: Native Node.js `EventEmitter` broadcasting 5-field structured activity events with a 100-event circular ring buffer for browser SSE synchronization.

---

## Problem Statement Alignment

| Requirement ID | Problem Description | Target Pain Point | Implemented Solution |
| :--- | :--- | :--- | :--- |
| `REQ-01` | Multilingual friction across Japanese, Hindi, and English with messy chat history. | Misunderstandings, communication hesitations, context loss in international channels. | **Cross-Cultural Bridge Node**: Real-time language identification, cultural entity extraction, bidirectional translation, and community FAQ logging in Notion. |
| `REQ-02` | Time-zone friction and organizer fatigue in planning international meetups. | Inactive community schedules, mismatch between Indian Standard Time (UTC+5:30) and Japan Standard Time (UTC+9:00). | **Event Orchestrator Node**: Automated Discord topic and time-slot polls, reaction tallying, time-zone overlap calculation, and bilingual Notion event page generation. |
| `REQ-03` | Manual promotional overhead across social networks and sponsor outreach. | Low public visibility, fragmented sponsor communication, organizer burnout. | **Growth & Sponsor Outreach Node**: Closed-loop ingestion of Notion event pages to draft compliant X/Twitter announcements and dispatch targeted sponsor emails via Resend. |
| `REQ-04` | Black-box execution during demonstrations and judging reviews. | Evaluators cannot inspect agent reasoning, intermediate decisions, or tool payloads. | **Live Telemetry & Activity Streaming**: Structured event logs streamed over SSE (`GET /api/events`) and ANSI-formatted console mirroring. |
| `REQ-05` | Real-time community engagement and automated thread moderation on Discord. | High maintenance overhead, manual bot interactions, lack of thread auto-replies. | **Discord Subsystem**: Dual Bot and Webhook client with Discord Gateway listener, reaction tallying, rate-limit retries, and local mock transport. |
| `REQ-06` | Need for minimal, transparent visibility without external APM infrastructure. | Complex setup requirements, database overhead, potential observability failures. | **Minimal Agent Activity Monitor (`AgentMonitor`)**: In-memory event bus tracking thoughts, tool calls, and results without external databases. |

---

## System Architecture

The following diagram illustrates the interaction between Discord community channels, the multi-agent reasoning supervisor, the `AgentMonitor` telemetry layer, and the Swytchcode tool execution boundary.

```mermaid
flowchart TD
    subgraph CommunityLayer ["Community Ingestion & Response"]
        DiscordGW["Discord Gateway / Webhook"]
        Listener["Message & Reaction Listener"]
        DiscordGW <--> Listener
    end

    subgraph ObservabilityLayer ["Minimal Activity Monitor (src/monitor/)"]
        Monitor["AgentMonitor (EventEmitter)"]
        Buffer["100-Event Circular Buffer"]
        ConsoleOut["CLI Console Printer"]
        SSEOut["SSE Endpoint: GET /api/events"]
        
        Monitor --> Buffer
        Monitor --> ConsoleOut
        Monitor --> SSEOut
    end

    subgraph CoreEngine ["Agent Reasoning & Coordination (src/agents/)"]
        Supervisor["Community Supervisor / Orchestrator"]
        Bridge["Cross-Cultural Bridge Agent"]
        EventNode["Event Orchestrator Agent"]
        GrowthNode["Growth & Sponsor Agent"]
        
        Supervisor --> Bridge
        Supervisor --> EventNode
        Supervisor --> GrowthNode
    end

    subgraph SwytchcodeBoundary ["Swytchcode Tooling Trust Boundary (.swytchcode/tooling.json)"]
        T_NotionPage["notion.page.create"]
        T_NotionQuery["notion.query.create"]
        T_Twitter["twitter_v2.tweet.create"]
        T_Resend["resend.email.create"]
    end

    Listener -->|Multilingual Messages| Bridge
    Listener -->|Poll Interactions| EventNode

    Bridge -.->|reasoning:thought| Monitor
    EventNode -.->|reasoning:thought| Monitor
    GrowthNode -.->|reasoning:thought| Monitor

    Bridge -->|Annotated Thread Reply| DiscordGW
    Bridge -->|Log Wiki Page| T_NotionPage

    EventNode -->|Post Topic Poll| DiscordGW
    EventNode -->|Create Event Spec| T_NotionPage

    T_NotionPage -->|Event URL & Metadata| GrowthNode
    GrowthNode -->|Broadcast Launch Tweet| T_Twitter
    GrowthNode -->|Fetch Sponsor CRM| T_NotionQuery
    GrowthNode -->|Send Tailored Pitch| T_Resend

    T_NotionPage -.->|tool:result| Monitor
    T_Twitter -.->|tool:result| Monitor
    T_Resend -.->|tool:result| Monitor
```

---

## Multi-Agent Subsystems Deep Dive

### 1. Cross-Cultural Bridge Node (`src/agents/bridge_agent.ts`)
- **Script & Language Identification**: Detects Japanese (Hiragana/Katakana/Kanji), Hindi (Devanagari), and English (Latin).
- **Entity Extraction**: Recognizes cultural markers, holidays, and honorifics (e.g., Diwali, Holi, Obon, Golden Week, -san, Ji) with contextual explanatory glosses.
- **Bidirectional Annotation**: Translates content between Japanese and English, appending explanatory cultural context cards to ensure clear understanding without condescension.
- **Discord Integration**: Hooks directly into `ThreadResponder` to generate threaded contextual replies for monitored community channels.

### 2. Event Orchestrator Node (`src/agents/event_agent.ts`)
- **Bicultural Scheduling**: Evaluates viable meeting windows accounting for the 3.5-hour time difference between India Standard Time (UTC+5:30) and Japan Standard Time (UTC+9:00).
- **Interactive Polling**: Builds multi-choice polls with keycap emojis, seeds bot reactions, tallies member votes, and resolves ties deterministically based on option priority.
- **Notion Event Publishing**: Transforms agreed topics and schedules into formatted Notion event specifications ready for public registration.

### 3. Growth & Sponsor Outreach Node (`src/agents/growth_agent.ts`)
- **Automated Social Broadcast**: Composes concise tweets within character bounds (280 units), integrating bilingual tags (`#Antigravity`, `#IndoJapanTech`) and event links.
- **Sponsor CRM & Pitch Dispatch**: Queries target partner profiles from Notion and generates structured, professional outreach emails via Resend with dynamic company and recipient insertion.

### 4. Discord Agent Subsystem (`src/discord/`)
- **Dual Transport Protocol**:
  - `BotRestTransport`: Authenticated bot execution via Discord REST API supporting message creation, thread creation, reaction management, and automatic HTTP 429 rate-limit backoff.
  - `WebhookTransport`: Lightweight fallback delivery for environments where full bot credentials are not provisioned.
  - `MockDiscordTransport`: Full in-memory loopback transport for unit testing and offline demonstrations.
- **Gateway Listener**: Websocket client handling Discord Gateway handshake, heartbeat cycles, and message event routing.

### 5. Minimal Agent Activity Monitor (`src/monitor/`)
- **Lightweight Event Contract**: Standardized 5-field payload:
  ```typescript
  interface AgentActivityEvent {
    timestamp: string;      // ISO 8601 (HH:MM:SS)
    agent: string;          // Supervisor | Bridge | Event | Growth | Discord
    type: 'thought' | 'tool_call' | 'tool_result' | 'error' | 'status';
    summary: string;        // Human-readable summary for monitors
    details?: Record<string, unknown>; // Optional structured context
  }
  ```
- **Real-Time Streaming**: Dispatches live Server-Sent Events (SSE) via `GET /api/events` and prints colored terminal output.
- **History Replay**: Retains the most recent 100 events in a circular ring buffer to instantly populate new monitoring sessions.

---

## Swytchcode Tooling Integration

The platform adheres strictly to the Swytchcode declarative tooling contract defined in `.swytchcode/tooling.json`. All tool interactions pass through `SwyCliExecutor` (`src/swytchcode/executor.ts`), which interfaces with the Swytchcode CLI runner:

- `notion.page.create`: Creates cultural knowledge base entries and bilingual event specifications.
- `notion.query.create`: Retrieves sponsor databases and community member lists.
- `twitter_v2.tweet.create`: Publishes social announcements to X/Twitter.
- `resend.email.create`: Sends individualized sponsorship proposals and event updates.

In mock mode (`DEMO_MODE=mock`), `MockToolExecutor` provides deterministic, zero-latency responses that conform exactly to Swytchcode JSON schemas.

---

## Technology Stack

- **Runtime**: Node.js (>= 23.6) using ECMAScript Modules (ESM)
- **Language**: TypeScript 5.9 (Strict type configuration, zero-emit validation)
- **Testing**: Native Node.js Test Runner (`node:test`, `node:assert/strict`)
- **APIs & Tooling**: Swytchcode CLI, Notion API, Twitter API v2, Resend API, Discord API v10
- **Observability**: Native Node.js `EventEmitter` + Server-Sent Events (SSE)

---

## Repository Structure

```text
Swytchcode/
├── .agents/                    # Custom agent skills, rules, and workflows
│   ├── rules/PERSONA.md        # Architectural rules and standards
│   └── workflows/              # Standard execution workflows
├── .swytchcode/
│   └── tooling.json            # Swytchcode tool definitions and schemas
├── dev/
│   ├── context/                # Problem statements, tracks, and walkthroughs
│   ├── plans/                  # Implementation plans and task lists
│   └── specs/                  # Functional specifications and user stories
├── src/
│   ├── agents/                 # Domain agent implementations
│   │   ├── bridge_agent.ts     # Cultural translation and entity recognition
│   │   ├── event_agent.ts      # Discord polls and event page drafting
│   │   ├── growth_agent.ts     # Social media and email outreach
│   │   └── orchestrator.ts     # Multi-agent coordination loop
│   ├── config/                 # Environment configuration and tool registries
│   │   ├── env.ts              # Configuration loader and key validator
│   │   └── swytchcode_tools.ts # Tool ID mapping and registry
│   ├── discord/                # Discord gateway and transport implementations
│   │   ├── discord_client.ts   # Bot and webhook transport layer
│   │   ├── mock_discord.ts     # Mock transport for offline execution
│   │   ├── poll_handler.ts     # Interactive poll generator and tally
│   │   └── thread_responder.ts # Bilingual thread auto-responder
│   ├── monitor/                # Observability subsystem
│   │   ├── agent_monitor.ts    # In-memory event bus and circular buffer
│   │   ├── console_printer.ts  # ANSI terminal output formatter
│   │   └── sse_handler.ts      # Server-Sent Events HTTP streamer
│   ├── swytchcode/             # Swytchcode tool executor and mocks
│   │   ├── executor.ts         # CLI stdio runner for Swytchcode tools
│   │   └── mock_executor.ts    # Schema-compliant mock executor + mock artifact store
│   └── demo/                   # Single-screen live demo
│       ├── server.ts           # HTTP server: UI, SSE, run/bridge APIs, mock pages
│       ├── index.html          # Demo UI (no build step)
│       ├── mock_views.ts       # Mock Notion page / X post views
│       ├── prompt_parser.ts    # Natural-language request parser
│       └── simulate.ts         # Terminal-only end-to-end simulation
├── tests/                      # Automated test suite (99 passing tests)
│   ├── agent_flow.test.ts      # End-to-end multi-agent orchestration test
│   ├── agents.test.ts          # Domain agent unit tests
│   ├── demo.test.ts            # Demo server, prompt parser, and mock page tests
│   ├── discord.test.ts         # Discord transport and gateway tests
│   ├── monitor.test.ts         # Observability and SSE stream tests
│   └── setup.test.ts           # Configuration and tooling boundary tests
├── .env.example                # Template for environment configuration
├── package.json                # Project scripts and dependencies
├── README.md                   # System documentation and setup guide
└── tsconfig.json               # TypeScript strict configuration
```

---

## Getting Started

### Prerequisites

- **Node.js**: Version `23.6.0` or higher (required for native `--env-file-if-exists` and modern test runner capabilities). Check with:
  ```bash
  node --version
  ```
- **npm**: Version `10.0.0` or higher.
- **Swytchcode CLI** (Optional for live mode): Installable via standard Swytchcode tooling procedures.

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Ryosuke-Kawashima-Career/Swytchcode.git
   cd Swytchcode
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Environment Configuration

The application operates in **Mock Mode** by default, requiring no external API credentials.

1. Copy the sample environment file:
   ```bash
   cp .env.example .env
   ```

2. Configure environment options in `.env`:

| Variable | Mode | Description |
| :--- | :--- | :--- |
| `DEMO_MODE` | Both | Set to `mock` (default, zero credentials) or `live` (invokes external APIs). |
| `PORT` | Both | Port for the local HTTP and SSE server (default: `3000`). |
| `SWYTCHCODE_TOKEN` | Live | Swytchcode authentication token for CLI tool execution. |
| `NOTION_DATABASE_ID` | Live | Target Notion database ID for events and cultural notes. |
| `NOTION_PARENT_PAGE_ID` | Live | Notion parent page ID under which new pages are nested. |
| `NOTION_API_VERSION` | Live | Notion API version header (default: `2025-09-03`). |
| `NOTION_SPONSOR_DATA_SOURCE_ID` | Live | Notion **data source** ID of the sponsor CRM (title, `Email` email, and `Company` text properties). |
| `RESEND_FROM_EMAIL` | Live | Verified sender email address for Resend outbound mail. |
| `SPONSOR_REPORT_EMAIL` | Live | Internal contact address for sponsor status reporting. |
| `DISCORD_BOT_TOKEN` | Live | Discord bot token for Gateway connection and reaction monitoring. |
| `DISCORD_WEBHOOK_URL` | Live | Webhook URL for fallback message dispatching. |
| `DISCORD_GUILD_ID` | Live | Discord Server (Guild) ID. |
| `DISCORD_CHANNEL_GENERAL_ID` | Live | Monitored Discord channel ID for cross-cultural messages. |
| `DISCORD_CHANNEL_EVENTS_ID` | Live | Monitored Discord channel ID for event polls. |
| `POLL_WINDOW_SECONDS` | Live | How long a live run waits for Discord votes (default: `60`). |

---

## How to Run

Run every command from the repository root. The demo needs no credentials.

### 1. Install

```bash
npm install
```

Only TypeScript and Node type definitions are installed (for `npm run typecheck`); the app has no runtime dependencies.

### 2. Start the demo UI

```bash
npm run dev
```

Open **http://localhost:3000**, keep the switch on **Offline demo**, and click **⚡ Run Autonomous Agent**. You will see:

- **🧠 Live Agent Activity & Reasoning** and **🔌 Swytchcode & Tool Execution**: live event streams (the same events print in the terminal).
- **Status badges** for Discord, Notion, X, and Resend, with call count, errors, and average latency.
- **Result cards**: poll outcome, Notion page, X post, and sponsor email results. In offline mode the Notion and X links open **mock pages** served by the demo (`/mock/notion/<id>`, `/mock/x/<id>`), marked with an orange "Mock" banner.
- **🌏 Try the Cultural Bridge**: click a sample message (or type one) to see the bilingual reply with cultural notes.

Press `Ctrl+C` to stop. The server listens on `127.0.0.1` only, because live mode can post and send email on your behalf.

### 3. Terminal-only simulation

```bash
npm run demo:simulate
```

Runs the Cultural Bridge on sample messages, then the whole loop (Discord polls → Notion page → X post → sponsor emails) offline, and prints an artifact summary.

### 4. Tests and type check

```bash
npm test                # all 99 tests
npm run test:setup      # config and Swytchcode tooling boundary
npm run test:monitor    # AgentMonitor, ring buffer, SSE
npm run test:discord    # Discord transports, polls, gateway
npm run test:agents     # Bridge and Event agents
npm run test:flow       # Swytchcode executor, Growth agent, closed loop
npm run test:demo       # demo server, prompt parser, mock pages
npm run typecheck       # prints nothing when clean
```

### 5. Swytchcode checks

```bash
swy doctor              # bundles, manifest, and session
swy list                # the four whitelisted tools
swy auth status         # which providers are connected
```

### Offline vs. Live mode

| | Offline demo (`mock`) | Live (`live`) |
| :--- | :--- | :--- |
| Discord | In-memory, simulated votes | Real bot (or webhook); waits `POLL_WINDOW_SECONDS` for votes |
| Notion / X / Resend | `MockToolExecutor`, nothing leaves your machine | Real calls through `swytchcode exec` |
| Credentials | None | See checklist below |

Keep `DEMO_MODE=mock` in `.env`. It is the default for API calls that do not specify a mode. The UI switch chooses the mode per run, so you can still try **Live** from the UI when you are ready.

**Live-mode checklist:**

1. `"mode": "production"` in `.swytchcode/tooling.json`. In `sandbox` mode requests go to `http://localhost`.
2. Connect providers: `swy auth connect Notion`, `swy auth connect Resend`, `swy auth connect Twitter`, then confirm with `swy auth status`.
3. Fill in `.env`: the Discord values (enable the bot's **Message Content** intent in the Developer Portal), `NOTION_PARENT_PAGE_ID`, `NOTION_SPONSOR_DATA_SOURCE_ID`, and `RESEND_FROM_EMAIL` (a verified Resend sender).
4. Select **Live** in the UI. The hint next to the switch warns about anything still missing.

> Live runs publish a real X post and email every contact in the sponsor data source. Test with a sponsor list that contains only your own address first.

### Troubleshooting

- **`Port 3000 is already in use`**: another server is on the port. Stop it, or set `PORT=3001` in `.env`. To find it (PowerShell): `Get-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess`
- **"Reconnecting…" in the UI title bar**: the server stopped. Restart it with `npm run dev`.
- **`missing credentials for <Provider>`** during a live run: run `swy auth connect <Provider>`.
- **Mock link returns 404**: mock pages live in memory and are cleared when the server restarts. Run the agent again.

---

## Operational Boundaries and Error Recovery

- **Rate Limit Resilience**: The Discord transport retries HTTP 429 responses up to 3 times, waiting the `retry_after` time Discord returns.
- **Graceful Degradation**: In live mode without Discord credentials, Discord falls back to the in-memory transport. Swytchcode tools always run live in live mode; a missing provider connection surfaces as a clear `auth` error in the monitor, and the run stops before anything downstream (no tweet without a Notion page).
- **Partial Outreach**: A failed sponsor email is logged and the remaining sponsors are still emailed.
- **Payload Truncation**: Embed descriptions and social posts are clamped to service-specific limits (e.g., 280 characters for X, 1024 characters for Discord embed fields).
- **Resource Cleanup**: All SSE subscribers and Gateway listeners detach listeners on connection termination to prevent memory leaks.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
