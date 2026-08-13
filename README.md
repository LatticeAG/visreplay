# VisReplay

**VisReplay** is a local session recorder and debugger for AI agents, by
LatticeAG. Wrap an agent object or WebSocket connection, save a portable
session file, replay its recorded events, compare runs, and export a structured
debug view.

VisReplay v1 is deliberately local-first. It makes no network requests and
does not upload, host, or rerun sessions.

## Install

```bash
npm install @latticeag/visreplay
```

VisReplay supports Node.js 20 or later.

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
});

const agent = recorder.wrap(new DeploymentAgent());
const result = await agent.run('Deploy to staging');

// Add agent-specific context when it is available to your integration.
recorder.recordReasoning('Tests passed, so staging deployment can proceed.');
recorder.recordToolCall('deploy', { environment: 'staging' });
recorder.recordToolResult({ deploymentId: 'dep_123', status: 'complete' });

await recorder.save('sessions/deploy-staging.vrs');

const debug = recorder.exportDebug();
console.log(result, debug.summary);
```

Calls made through the wrapped object produce ordered `input` and `output` or
`error` events. VisReplay preserves the method's return value or thrown error.
Use the manual recording methods for context that a generic proxy cannot know,
such as model reasoning and tool semantics.

`save()` accepts `.vrs` and `.json` paths. It creates missing parent
directories and writes a single self-contained UTF-8 JSON document.

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

## SDK API

```ts
class VisReplay {
  constructor(options?: VisReplayOptions);
  wrap<T extends object>(agent: T): T;
  log(event: NewSessionEvent): SessionEvent;
  recordReasoning(content: unknown): SessionEvent;
  recordToolCall(name: string, args: Record<string, unknown>): SessionEvent;
  recordToolResult(result: unknown): SessionEvent;
  recordWebSocket<T extends object>(socket: T, options?: WebSocketRecordingOptions): WebSocketRecording<T>;
  wrapWebSocket<T extends object>(socket: T, options?: WebSocketRecordingOptions): T;
  getEvents(): SessionEvent[];
  getSession(): SessionData;
  save(filePath: string): Promise<void>;
  exportDebug(): DebugExport;
  static load(
    filePath: string,
    options?: Pick<VisReplayOptions, 'redactKeys' | 'redactPatterns'>
  ): Promise<VisReplay>;
}
```

All constructor options are optional. The defaults are the session name
`"unnamed-session"` and agent type `"unknown"`. `getEvents()`, `getSession()`,
and `exportDebug()` return snapshots, so changing a returned object does not
change the recorder.

Load a saved session when you need to inspect or export it in code:

```ts
import { VisReplay } from '@latticeag/visreplay';

const recorder = await VisReplay.load('sessions/deploy-staging.vrs');
const errors = recorder.getEvents().filter((event) => event.type === 'error');
const debug = recorder.exportDebug();
```

`Player` has cursor-level `stepForward()`, `stepBackward()`, `jumpTo()`, and
`reset()` operations, plus `pause()`, `resume()`, and `stop()` for host UIs.
Use `compareSessions()` for two in-memory session documents or
`compareSessionFiles()` for recordings on disk. Comparisons are deterministic,
index-aligned, and report unchanged, changed, added, and removed events.

`examples/full-workflow.ts` is an end-to-end example that records a session,
saves it, auto-replays it, and writes Markdown and HTML exports.

## Recorded session format

VisReplay writes the versioned `visreplay/session/1.0` format. Events are
ordered, zero-based, and timestamped in UTC. A representative session looks
like this:

```json
{
  "$schema": "visreplay/session/1.0",
  "sessionId": "session_...",
  "sessionName": "deploy-staging",
  "agentType": "custom",
  "startedAt": "2026-07-21T09:00:00.000Z",
  "events": [
    {
      "eventId": "event_...",
      "index": 0,
      "timestamp": "2026-07-21T09:00:01.000Z",
      "type": "input",
      "method": "run",
      "content": ["Deploy to staging"]
    },
    {
      "eventId": "event_...",
      "index": 1,
      "timestamp": "2026-07-21T09:00:02.000Z",
      "type": "output",
      "method": "run",
      "content": "Completed: Deploy to staging"
    }
  ]
}
```

The six v1 event types are `input`, `reasoning`, `tool_call`, `tool_result`,
`output`, and `error`.

## Debug export

`exportDebug()` and `visreplay export` produce the separate
`visreplay/debug/1.0` format. It contains the original events plus a concise
timeline and a summary with event counts, error count, and first error when
one exists. With `--output`, the CLI writes formatted JSON to that path and
prints a one-line confirmation. Without `--output`, standard output contains
JSON only.

For code integrations, `renderExport(debug, 'json' | 'markdown' | 'html')`,
`renderMarkdownReport(debug)`, `renderHtmlTimeline(debug)`, and
`renderDebugViewer(debug)` create the same portable formats without invoking
the CLI. The interactive viewer contains no remote assets and supports search,
event-type filtering, keyboard navigation, event detail inspection, and
incremental rendering for large sessions.

## Data handling

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
`Session.load(path, { maxFileBytes, maxEvents })` only when a known-good large
recording requires a higher limit.

## v1 scope

VisReplay v1 includes local recording, file persistence, deterministic replay,
debug export, an interactive local viewer, and recording comparison. It does
not include hosted storage, SaaS uploads, dashboard sharing, automatic network
synchronization, agent or tool reruns, session forking, streaming-token
capture, or framework-specific instrumentation.

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
