# VisReplay

Session recorder and debugger for AI agents -- record, replay, and compare agent decisions.

**by LatticeAG**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?logo=typescript&logoColor=white&labelColor=black)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![Open Source](https://img.shields.io/badge/Open-Source-black.svg?logo=github&logoColor=white)](https://github.com/LatticeAG/visreplay)
[![npm](https://img.shields.io/badge/npm-@latticeag/visreplay-cb3837?logo=npm&logoColor=white&labelColor=black)](https://www.npmjs.com/package/@latticeag/visreplay)

---

## Overview

> **VisReplay records every agent decision into a replayable session file. Step through decisions like a video player. Fork at any point and re-run to compare behavioral paths.**
> 
> Debugging agent failures shouldn't mean guessing from logs.

Tool calls are text, reasoning traces are lost, and non-deterministic behavior makes "what happened?" nearly impossible to answer without replaying the exact session. VisReplay makes every agent decision inspectable, replayable, and comparable.

```
           Agent Session
                │
                ▼
      ┌─────────────────┐
      │  VisReplay SDK  │
      │  (wrap proxy)   │
      └────────┬────────┘
               │
        Event Log (JSON)
               │
      ┌────────┴────────┐
      │                 │
      ▼                 ▼
┌──────────┐     ┌──────────┐
│ CLI      │     │ SaaS     │
│ Player   │     │ Dashboard│
│ (local)  │     │ (hosted) │
└──────────┘     └──────────┘
```

OSS recorder SDK (MIT) for instrumentation. SaaS for hosted session storage, search, and team sharing.

---

## Core Features

| Feature | Description |
|---------|-------------|
| **Zero-Code-Change SDK** | Wrap your agent client with `new VisReplay().wrap(agent)` -- no code changes |
| **Full Session Capture** | Inputs, reasoning traces, tool calls and results, final outputs |
| **Event-Sourced Format** | Sessions are append-only JSON event logs -- simple, debuggable, human-readable |
| **Step-by-Step Replay** | CLI player lets you walk through each decision point interactively |
| **Fork & Re-run** | Fork at any decision point, modify prompt or tools, re-run to compare |
| **Side-by-Side Paths** | Compare two session paths to find exactly where behavior diverged |
| **Framework Agnostic** | Works with OpenAI SDK, LangChain, Hermes, custom agents -- any Promise-returning client |

---

## Quick Start

```bash
# Install
npm install @latticeag/visreplay
```

### Instrument your agent

```typescript
import { VisReplay } from "@latticeag/visreplay";

// Wrap any agent client -- zero code changes
const recorder = new VisReplay({ sessionName: "debug-session-1" });
const agent = recorder.wrap(myAgent);

// Run as normal -- everything is recorded
const result = await agent.run("Deploy to staging");

// Save the session to a file
await recorder.save("session.json");
```

### Replay locally

```bash
# Interactive step-through
npx visreplay replay session.json

# Auto-play through
npx visreplay replay session.json --auto

# Upload to SaaS (when hosted)
npx visreplay upload session.json --share
```

---

## Commands

| Command | Description |
|---------|-------------|
| `visreplay replay <file>` | Interactive step-through of a session file |
| `visreplay replay <file> --auto` | Auto-play through the session |
| `visreplay upload <file>` | Upload session to SaaS dashboard |

---

## Session File Format

Sessions are stored as an append-only event log:

```json
{
  "sessionName": "debug-session-1",
  "startedAt": "2026-07-02T00:00:00Z",
  "agentType": "custom",
  "events": [
    { "type": "input",     "timestamp": "...", "content": "Deploy to staging",         "index": 0 },
    { "type": "reasoning", "timestamp": "...", "content": "I need to deploy...",        "index": 1 },
    { "type": "tool_call", "timestamp": "...", "name": "write_file", "arguments": {...}, "index": 2 },
    { "type": "tool_result","timestamp": "...", "content": "File written successfully", "index": 3 },
    { "type": "output",    "timestamp": "...", "content": "Deployment complete",         "index": 4 }
  ]
}
```

### Event Types

| Type | Description |
|------|-------------|
| `input` | User message or task input |
| `reasoning` | Model reasoning trace / completion |
| `tool_call` | Tool name and arguments |
| `tool_result` | Tool response content |
| `output` | Final agent output |

---

## API

### VisReplay

```typescript
class VisReplay {
  constructor(options?: {
    sessionName?: string;
  });

  // Wrap an agent client to record all activity
  wrap<T extends { run(input: string): Promise<any> }>(agent: T): T;

  // Manually log an event
  log(event: Omit<SessionEvent, 'timestamp' | 'index'>): void;

  // Save session to file
  save(path: string): Promise<void>;

  // Load session from file
  static load(path: string): VisReplay;

  // Get all events
  getEvents(): SessionEvent[];
}
```

---

## File Structure

```
visreplay/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts       # Public API exports
│   ├── recorder.ts    # VisReplay class + wrap proxy
│   ├── session.ts     # Session data model + file I/O
│   ├── types.ts       # SessionEvent type definitions
│   ├── player.ts      # Replay logic for step-through
│   └── cli.ts         # Commander CLI entry point
├── tests/
│   └── recorder.test.ts
├── examples/
│   └── basic-usage.ts
└── README.md
```

---

## Integration

VisReplay works with any agent framework. The wrap pattern works with any object
that has a `run()` method returning a Promise:

```typescript
// OpenAI SDK
const openai = new OpenAI();
const recorded = recorder.wrap(openai);

// Custom agent
class MyAgent {
  async run(input: string) { /* ... */ }
}
const recorded = recorder.wrap(new MyAgent());
```

---

## Roadmap

| Phase | Feature | Status |
|:-----:|---------|:------:|
| 1 | Recorder SDK with wrap proxy | Done |
| 2 | Event-sourced session format | Done |
| 3 | CLI replay player | Done |
| 4 | Fork and re-run support | Planned |
| 5 | Side-by-side path comparison | Planned |
| 6 | SaaS dashboard (hosted sessions) | Planned |

---

## Links

- **Product page:** [latticeag.vercel.app/products/visreplay](https://latticeag.vercel.app/products/visreplay)
- **Source code:** [github.com/LatticeAG/visreplay](https://github.com/LatticeAG/visreplay)
- **LatticeAG:** [latticeag.vercel.app](https://latticeag.vercel.app)

---

## License

MIT -- see [LICENSE](./LICENSE).

---

**LatticeAG** -- *Agents, together.*
[github.com/LatticeAG/visreplay](https://github.com/LatticeAG/visreplay)
