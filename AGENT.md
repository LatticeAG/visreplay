# VisReplay

> LatticeAG's local session recorder and debugger for AI agents.

## Identity

- **Package:** `@latticeag/visreplay`
- **CLI:** `visreplay`
- **License:** MIT
- **Runtime:** Node.js 20+
- **Primary API:** `VisReplay`

VisReplay records an agent's method calls and explicit debugging events into a
portable local session file. It can replay those recorded events and export a
structured debug report. It never makes network requests.

## Source of truth

[`README.md`](./README.md) is the public product contract. Internal design
documents are deliberately not part of this repository. Do not represent a
future feature as working functionality.

## v1.1 scope

- Record sync and async method calls through `recorder.wrap(agent)`.
- Record manual reasoning, tool-call, tool-result, and decision events.
- Redact common secret-like keys before events are exposed or persisted.
- Save and load one versioned JSON session document atomically.
- Replay a local file interactively or automatically.
- Export a `visreplay/debug/1.0` JSON report, Markdown, HTML, or vendor
  interop files. Interop writes files. It does not upload them.
- Compare two local session files.

Hosted storage, uploads, MCP, Cloudflare Workers, forks, reruns, UI besides
the self-contained HTML viewer, and framework-specific adapters are not
included.

## Module map

```
src/
├── types.ts         # Shared schemas, event types, decision types, and safe value helpers
├── session.ts       # Validation, snapshots, end(), atomic persistence, debug export
├── atomic-write.ts  # Shared atomic UTF-8 file writer with EXDEV fallback
├── recorder.ts      # VisReplay API, redaction, wrap, recordDecision, onCaptureError
├── websocket.ts     # Passive WebSocket observation
├── player.ts        # Read-only cursor navigation and terminal rendering
├── diff.ts          # Index-aligned session comparison
├── render.ts        # Markdown, HTML, debug-viewer rendering, and export format parsing
├── interop.ts       # Langfuse, OTLP, and LangSmith file exporters
├── cli.ts           # visreplay replay, export, debug, and compare
└── index.ts         # Public SDK exports
```

CLI commands: `replay`, `export`, `debug`, `compare`.

Each source module has a co-located Vitest test file. Keep the test surface
aligned with the public behavior rather than testing implementation details.

## Typical use

```ts
import { VisReplay } from '@latticeag/visreplay';

const recorder = new VisReplay({ sessionName: 'deploy-staging' });
const agent = recorder.wrap(myAgent);
await agent.run('Deploy to staging');
await recorder.save('sessions/deploy-staging.vrs');
```

```bash
visreplay replay sessions/deploy-staging.vrs --auto
visreplay export sessions/deploy-staging.vrs --output debug.json
```

## Quality gate

```bash
npm ci
npm run check
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

CI runs `npm ci`, `npm run check`, `npm run build`, pack-install smoke, and a
src network grep on Node 20 and Node 22. Keep the product name VisReplay and
LatticeAG branding in user-facing output.
