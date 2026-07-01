# LexReplay — Session Recorder and Debugger for AI Agents

> OSS SDK (MIT). TypeScript. Scaffold the full project.

## Identity

- **Name:** LexReplay
- **Tagline:** Record, replay, and debug agent sessions
- **Repo:** https://github.com/LatticeAG/lexreplay
- **License:** MIT
- **Framework:** TypeScript (Node.js npm package)

## Architecture

Two parts: a recorder SDK and a CLI replay tool, in a single npm package.

### Recorder SDK

A class that wraps any agent client and captures every decision:

```typescript
import { LexReplay } from "@latticeag/lexreplay";

const recorder = new LexReplay({ sessionName: "my-session" });
const agent = recorder.wrap(myAgentClient);
const result = await agent.run("Deploy to staging");
await recorder.save("session.json");
```

**Captures per turn:**
- User input
- Model reasoning (the raw completion / streamed chunks)
- Tool calls made (name, arguments, timing)
- Tool results returned
- Final output
- Latency per step

### Session File Format

JSON with a structured event log:

```json
{
  "sessionName": "my-session",
  "startedAt": "...",
  "agentType": "openai",
  "events": [
    { "type": "input", "timestamp": "...", "content": "...", "index": 0 },
    { "type": "reasoning", "timestamp": "...", "content": "...", "index": 1 },
    { "type": "tool_call", "timestamp": "...", "name": "search", "arguments": {...}, "index": 2 },
    { "type": "tool_result", "timestamp": "...", "content": "...", "index": 3 },
    { "type": "output", "timestamp": "...", "content": "...", "index": 4 }
  ]
}
```

### CLI Player

```
lattice replay session.json       # Interactive step-through
lattice replay session.json --auto  # Play through automatically
lattice upload session.json        # Upload to SaaS (future)
```

## File Structure

```
lexreplay/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public API exports
│   ├── recorder.ts           # LexReplay class + wrap logic
│   ├── session.ts            # Session data structures + serialization
│   ├── types.ts              # TypeScript types (SessionEvent, etc.)
│   ├── player.ts             # CLI replay logic
│   └── cli.ts                # CLI entry point (commander)
├── tests/
│   └── recorder.test.ts
├── examples/
│   └── basic-usage.ts
└── README.md
```

## Key Design Decisions

1. **Wrap pattern** — `recorder.wrap(agent)` returns a proxied agent that records all activity. Works with OpenAI SDK, any agent that returns promises.
2. **Event-sourced format** — session files are append-only event logs. Simple, debuggable, human-readable.
3. **Zero-code-change** — the wrap pattern means you don't modify your agent code. Just wrap the client.
4. **CLI via commander** — `lattice replay`, `lattice upload` subcommands.
5. **TypeScript** — type-safe, npm ecosystem, natural for SDKs.

## Build Order

1. `package.json` + `tsconfig.json` with dependencies (commander, typescript, @types/node)
2. `src/types.ts` — all type definitions
3. `src/session.ts` — session data model + file I/O
4. `src/recorder.ts` — LexReplay class with wrap proxy
5. `src/player.ts` — replay logic
6. `src/cli.ts` — wire up commander
7. `src/index.ts` — public exports
8. `tests/` — basic tests
9. `examples/` — usage example
