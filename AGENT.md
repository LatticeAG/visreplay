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
structured debug report. v1 never makes network requests.

## Source of truth

[`BUILD-SPEC.md`](./BUILD-SPEC.md) is the locked v1 implementation contract.
[`SPEC.md`](./SPEC.md) and [`SPEC-DeepDebug.md`](./SPEC-DeepDebug.md) describe
future product directions. Do not represent a future feature as working v1
functionality.

## v1 scope

- Record sync and async method calls through `recorder.wrap(agent)`.
- Record manual reasoning, tool-call, and tool-result events.
- Redact common secret-like keys before events are exposed or persisted.
- Save and load one versioned JSON session document atomically.
- Replay a local file interactively or automatically.
- Export a `visreplay/debug/1.0` JSON report.

Hosted storage, uploads, MCP, Cloudflare Workers, forks, reruns, UI, and
framework-specific adapters are not included in v1.

## Module map

```
src/
├── types.ts     # Shared v1 schemas, event types, and safe value helpers
├── session.ts   # Validation, snapshots, atomic persistence, debug export
├── recorder.ts  # VisReplay API, redaction, and proxy instrumentation
├── player.ts    # Read-only cursor navigation and terminal rendering
├── cli.ts       # visreplay replay and export commands
└── index.ts     # Public SDK exports
```

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
```

CI runs `npm ci` and `npm run check` on Node 20. Keep the product name
VisReplay and LatticeAG branding in user-facing output.
