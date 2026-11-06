# VisReplay

**The open, local-first agent observability + collaboration stack: record, replay, diff, and inspect agent behavior - then plan and ship with humans in the same workspace.**

**VisReplay** is a local session recorder and debugger for AI agents, by
LatticeAG. Wrap an agent object or WebSocket connection, save a portable
session file, replay its recorded events, compare runs, and export a structured
debug view.

VisReplay v1.1 is deliberately local-first. It makes no network requests and
does not upload, host, or rerun sessions.

## Install

```bash
npm install @latticeag/visreplay
```

VisReplay supports Node.js 20 or later.

Repo examples import from `../src`. Published consumers import from
`@latticeag/visreplay`.

## Record a session

```ts
import { VisReplay } from '@latticeag/visreplay';

class DeploymentAgent {
  async run(task: string): Promise<string> {
    return `Completed: ${task}`;
  }
}

const recorder = new VisReplay({
  sessionName: 'deploy-staging',
  agentType: 'custom',
  onCaptureError: (error) => {
    console.error('recording failed', error);
  },
});

const agent = recorder.wrap(new DeploymentAgent());
const result = await agent.run('Deploy to staging');

// Add agent-specific context when it is available to your integration.
recorder.recordReasoning('Tests passed, so staging deployment can proceed.');
recorder.recordToolCall('deploy', { environment: 'staging' });
recorder.recordToolResult({ deploymentId: 'dep_123', status: 'complete' });
recorder.end();

await recorder.save('sessions/deploy-staging.vrs');

const debug = recorder.exportDebug();
console.log(result, debug.summary);
```

Calls made through the wrapped object produce ordered `input` and `output` or
`error` events. VisReplay preserves the method's return value or thrown error.
Use the manual recording methods for context that a generic proxy cannot know,
such as model reasoning and tool semantics.

`save()` accepts `.vrs` and `.json` paths. It creates missing parent
directories and writes a single self-contained UTF-8 JSON document. `end()`
marks the logical end of a run by setting `endedAt`. Later `log` calls are
still appended; `endedAt` stays the first end time.

## Record a decision

Use `recordDecision` when you know why a step happened. It writes a
`reasoning` event whose `metadata.visreplay` object has `kind: "decision"` and
schema `visreplay/decision/1.0`. The on-disk session schema stays
`visreplay/session/1.0`.

```ts
recorder.recordDecision({
  believed: { tests: 'green' },
  assumed: { stagingSharesProdCredentials: false },
  ignored: { canary: 'not required for staging' },
  summary: 'Proceed with staging release',
});
```

Values go through the same redaction as other recorded fields. Nested keys
such as `token` or `apiKey` become `[REDACTED]` before `getEvents()` or
`save()`.

## Record a WebSocket agent session

Use `recordWebSocket()` when an agent communicates through a browser-style
WebSocket/EventTarget or a Node EventEmitter-style socket. Incoming messages
are recorded as `output` events and calls to the returned socket's `send()`
method are recorded as `input` events. VisReplay observes the connection; it
does not open one or send any traffic itself.

```ts
const connection = recorder.recordWebSocket(socket, {
  name: 'agent-stream',
  // JSON text frames are parsed by default, so nested secrets are redacted.
  transformMessage: (message, context) => ({ direction: context.direction, message }),
});

connection.socket.send(JSON.stringify({ task: 'summarize' }));
// ...the underlying socket receives messages...
connection.detach(); // safe and idempotent when the session is finished
```

Text frames are bounded to 1 MiB by default so an unexpectedly large frame
does not make a recording unbounded. Set `maxPayloadBytes` deliberately when a
known protocol needs a larger capture limit.

## Replay and export

```bash
# Step through each recorded event. Press Enter to advance or q to stop.
npx visreplay replay sessions/deploy-staging.vrs

# Print all events without prompts.
npx visreplay replay sessions/deploy-staging.vrs --auto

# Optionally add a delay between auto-played events, in milliseconds.
npx visreplay replay sessions/deploy-staging.vrs --auto --delay 250

# Write the normalized debug export to a file.
npx visreplay export sessions/deploy-staging.vrs --output deploy-debug.json

# Or emit JSON only to standard output for a pipeline.
npx visreplay export sessions/deploy-staging.vrs > deploy-debug.json

# Export a readable incident report or a static HTML timeline.
npx visreplay export sessions/deploy-staging.vrs --format markdown --output deploy-report.md
npx visreplay export sessions/deploy-staging.vrs --format html --output deploy-timeline.html

# Generate an interactive, self-contained local debug viewer.
npx visreplay debug sessions/deploy-staging.vrs --output deploy-debug.html

# Compare two recordings. IDs and timestamps are ignored by default so the
# result focuses on behavioural changes.
npx visreplay compare sessions/baseline.vrs sessions/candidate.vrs
```

Replay reads recorded data only. It never calls the original agent, tools, or
external services.

`exportDebug()` and `visreplay export` produce the separate
`visreplay/debug/1.0` format. It contains the original events plus a concise
timeline, a summary, and any decision records. With `--output`, the CLI writes
the file and prints a one-line confirmation. Without `--output`, standard
output contains the document only.

For code integrations, `renderExport(debug, 'json' | 'markdown' | 'html')`,
`renderMarkdownReport(debug)`, `renderHtmlTimeline(debug)`, and
`renderDebugViewer(debug)` create the same portable formats without invoking
the CLI. The interactive viewer contains no remote assets and supports search,
event-type filtering including decisions, keyboard navigation, event detail
inspection, and incremental rendering for large sessions.

`Player` has cursor-level `stepForward()`, `stepBackward()`, `jumpTo()`, and
`reset()` operations, plus `pause()`, `resume()`, and `stop()` for host UIs.
Use `compareSessions()` for two in-memory session documents or
`compareSessionFiles()` for recordings on disk. Comparisons are deterministic,
index-aligned, and report unchanged, changed, added, and removed events.

`examples/full-workflow.ts` is an end-to-end example that records a session,
saves it, auto-replays it, and writes Markdown and HTML exports.
After `npm ci`, run it with `npm run example:full`; run the smaller recording
example with `npm run example:basic`. These write `visreplay-demo/` and
`deploy-staging.vrs`, respectively, under the current directory.

## Interop export

VisReplay can write Langfuse ingestion-batch JSON, OTLP/JSON traces, and
LangSmith run-list JSON from a local session file. These commands write files
only. They do not upload, open a network connection, or talk to a vendor API.

```bash
npx visreplay export sessions/deploy-staging.vrs --format langfuse --output ingest.json
npx visreplay export sessions/deploy-staging.vrs --format otlp --output trace.otlp.json
npx visreplay export sessions/deploy-staging.vrs --format langsmith --output runs.json
```

In code, `exportInterop(session, 'otlp')` returns the vendor document plus
warnings. `renderInterop(session, 'langfuse')` returns the vendor JSON only,
ready to write to disk. Unknown token counts and costs are omitted, never
invented.

## Data handling

VisReplay writes the versioned `visreplay/session/1.0` format. Events are
ordered, zero-based, and timestamped in UTC. The six v1 event types are
`input`, `reasoning`, `tool_call`, `tool_result`, `output`, and `error`.

Recorded values are converted to safe JSON data. Circular references,
`undefined`, bigints, errors, functions, symbols, and other non-JSON values
are represented visibly instead of making recording fail.

Common secret keys are redacted recursively by default, including `apiKey`,
`api_key`, `authorization`, `password`, `secret`, and `token`. Add keys for
your application with `redactKeys`:

```ts
const recorder = new VisReplay({
  redactKeys: ['accessToken', 'customerSecret'],
});
```

Passing `redactKeys: []` disables the default key list and, for backwards
compatibility, the implicit regex list unless `redactPatterns` is supplied
explicitly. Session files are local plain JSON, so review their contents and
storage permissions before sharing them.

Secrets embedded in text can be redacted with regular expressions. Patterns
may be `RegExp` instances, pattern strings, or JSON-friendly `{ pattern,
flags }` objects:

```ts
const recorder = new VisReplay({
  redactPatterns: [
    /customer_[A-Za-z0-9_-]+/g,
    { pattern: 'internal-[A-Za-z0-9]+', flags: 'gi' },
  ],
});
```

Common OpenAI-, GitHub-, AWS-, and JWT-shaped strings are redacted by default;
the default `authorization` key also redacts ordinary Bearer credentials. Pass
`redactPatterns: []` when an intentionally unredacted local recording is
required. Regex redaction applies to text values, matching property names,
manual events, WebSocket messages, loaded files, and exports.

Loading a file applies the same default redaction before it is replayed or
exported. Use the optional load argument only when you intentionally need an
unredacted local inspection:

```ts
const recorder = await VisReplay.load('session.vrs', { redactKeys: [] });
```

Empty recordings are valid and export as an empty timeline. Corrupt, empty,
non-UTF-8, or malformed session files fail with actionable errors. `Session`
also rejects files over 64 MiB or more than 500,000 events by default; use
`Session.load(path, { maxFileBytes, maxEvents })` or the matching CLI flags
only when a known-good large recording requires a higher limit.

## v1.1 scope

VisReplay v1.1 includes local recording, file persistence, deterministic
replay, debug export, an interactive local viewer, recording comparison, a
decision ledger, and file-only vendor interop exporters. It does not include
hosted storage, SaaS uploads, dashboard sharing, automatic network
synchronization, agent or tool reruns, session forking, streaming-token
capture, or framework-specific instrumentation.

## How this compares

Armature reconstructs agent sessions server-side from MCP tool calls. VisReplay records at the source, locally, into portable session files - replay, compare, export - no network, you keep the data.

**Everything the new YC agent-observability startups are building - open-sourced, self-hosted, MIT.**

## Development

```bash
npm ci
npm run check
npm run build
node dist/cli.js --help
```

The test suite uses Vitest. `npm run check` performs strict TypeScript type
checking and runs all tests.

## License

MIT. VisReplay is a LatticeAG project.

## Security

Report vulnerabilities through GitHub private vulnerability reporting on
LatticeAG/visreplay. See `SECURITY.md`. Do not file secrets in public issues.
