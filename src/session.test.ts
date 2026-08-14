import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Session } from './session';
import { SessionData } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Session', () => {
  it('creates a canonical v1 document and assigns contiguous event envelopes', () => {
    const session = new Session('agent-run', 'custom-agent', 'ses_test');
    const first = session.addEvent({ type: 'input', content: 'deploy' });
    const second = session.addEvent({ type: 'output', content: { ok: true } });

    expect(session.getData()).toMatchObject({
      $schema: 'visreplay/session/1.0',
      sessionId: 'ses_test',
      sessionName: 'agent-run',
      agentType: 'custom-agent'
    });
    expect(first).toMatchObject({ eventId: expect.stringMatching(/^evt_/), index: 0, type: 'input' });
    expect(second).toMatchObject({ eventId: expect.stringMatching(/^evt_/), index: 1, type: 'output' });
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp);
  });

  it('returns defensive snapshots from event and data accessors', () => {
    const session = new Session('immutable');
    const event = session.addEvent({ type: 'tool_call', name: 'read', arguments: { path: '/tmp/source' } });
    event.arguments!.path = '/tmp/mutated-return';

    const events = session.getEvents();
    events[0].arguments!.path = '/tmp/mutated-array';
    const data = session.data;
    data.events[0].arguments!.path = '/tmp/mutated-data';

    expect(session.getEvents()[0].arguments).toEqual({ path: '/tmp/source' });
  });

  it('rejects unknown, malformed, and caller-assigned event fields', () => {
    const session = new Session('validation');

    expect(() => session.addEvent({ type: 'unknown', content: 'nope' } as never)).toThrow('Unknown event type');
    expect(() => session.addEvent({ type: 'tool_call', name: 'read' } as never))
      .toThrow('requires a non-empty name and arguments object');
    expect(() => session.addEvent({ type: 'input', content: 'x', index: 9 } as never))
      .toThrow('assigned by Session');
  });

  it('safely serializes circular and non-JSON manual event values', () => {
    const session = new Session('serialization');
    const circular: Record<string, unknown> = { count: 1, missing: undefined, big: 8n };
    circular.self = circular;

    session.addEvent({ type: 'output', content: circular });

    expect(session.getEvents()[0].content).toEqual({
      big: '[BigInt: 8]',
      count: 1,
      missing: '[undefined]',
      self: '[Circular]'
    });
  });

  it('saves nested paths atomically and loads the same validated document', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'nested', 'session.vrs');
    const session = new Session('persisted', 'test-agent', 'ses_persisted');
    session.addEvent({ type: 'input', content: 'first' });
    await session.save(filePath);

    session.addEvent({ type: 'output', content: 'second' });
    await session.save(filePath);

    const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as SessionData;
    const loaded = await Session.load(filePath);
    expect(onDisk).toEqual(loaded);
    expect(loaded.events.map(event => event.index)).toEqual([0, 1]);
    expect(loaded.events.map(event => event.content)).toEqual(['first', 'second']);
  });

  it('redacts untrusted data while loading or restoring, unless explicitly disabled', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'untrusted.vrs');
    const raw = createRawSessionData({
      token: 'default-secret',
      nested: { authorization: 'Bearer hidden' }
    });
    await writeFile(filePath, JSON.stringify(raw), 'utf8');

    const loaded = await Session.load(filePath);
    const restored = Session.fromData(raw);
    const unredacted = await Session.load(filePath, []);

    expect(loaded.events[0].content).toEqual({
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]' }
    });
    expect(restored.getEvents()[0].content).toEqual(loaded.events[0].content);
    expect(unredacted.events[0].content).toEqual({
      token: 'default-secret',
      nested: { authorization: 'Bearer hidden' }
    });
  });

  it('redacts configured regex patterns in scalar event fields and loaded payloads', async () => {
    const patterns = [/sk-[A-Za-z0-9_-]{8,}/i, /sensitiveMethod/i];
    const session = new Session('pattern-redaction', 'test', 'ses_patterns', [], patterns);
    const event = session.addEvent({
      type: 'error',
      method: 'sensitiveMethod',
      error: 'upstream rejected sk-abcdefghijklmnop'
    });

    expect(event).toMatchObject({
      method: '[REDACTED]',
      error: 'upstream rejected [REDACTED]'
    });

    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'pattern.vrs');
    const raw = createRawSessionData('socket message: sk-qrstuvwxyzabcdef');
    await writeFile(filePath, JSON.stringify(raw), 'utf8');

    const loaded = await Session.load(filePath, { redactKeys: [], redactPatterns: patterns });
    expect(loaded.events[0].content).toBe('socket message: [REDACTED]');
  });

  it('keeps legacy explicit key configuration free of implicit value patterns', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'legacy-redaction.vrs');
    const raw = createRawSessionData('socket message: sk-abcdefghijklmnop');
    await writeFile(filePath, JSON.stringify(raw), 'utf8');

    expect((await Session.load(filePath)).events[0].content).toBe('socket message: [REDACTED]');
    expect((await Session.load(filePath, [])).events[0].content).toBe('socket message: sk-abcdefghijklmnop');
    expect((await Session.load(filePath, { redactKeys: [] })).events[0].content)
      .toBe('socket message: sk-abcdefghijklmnop');
  });

  it('supports empty recordings and rejects empty, invalid-UTF8, and oversized session files clearly', async () => {
    const directory = await createTemporaryDirectory();
    const emptyRecordingPath = join(directory, 'empty-recording.vrs');
    const emptyRecording = new Session('empty-recording', 'test', 'ses_empty');
    await emptyRecording.save(emptyRecordingPath);

    const loadedEmptyRecording = await Session.load(emptyRecordingPath);
    expect(loadedEmptyRecording.events).toEqual([]);
    expect(emptyRecording.exportDebug().summary).toMatchObject({ eventCount: 0, errorCount: 0 });

    const blankPath = join(directory, 'blank.vrs');
    await writeFile(blankPath, ' \n\t ', 'utf8');
    await expect(Session.load(blankPath)).rejects.toThrow('empty or whitespace only');

    const invalidUtf8Path = join(directory, 'invalid-utf8.vrs');
    await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
    await expect(Session.load(invalidUtf8Path)).rejects.toThrow('Invalid UTF-8');

    const constrainedPath = join(directory, 'constrained.vrs');
    const constrained = createRawSessionData('large enough for a byte limit');
    await writeFile(constrainedPath, JSON.stringify(constrained), 'utf8');
    await expect(Session.load(constrainedPath, { maxFileBytes: 8 })).rejects.toThrow('exceeds the 8-byte limit');
    await expect(Session.load(constrainedPath, { maxEvents: 0 })).rejects.toThrow('exceeding the 0-event limit');
  });

  it('rejects malformed JSON and tampered event indices with actionable errors', async () => {
    const directory = await createTemporaryDirectory();
    const malformedPath = join(directory, 'malformed.vrs');
    await writeFile(malformedPath, '{not JSON', 'utf8');
    await expect(Session.load(malformedPath)).rejects.toThrow('Invalid JSON');

    const session = new Session('tampered', 'test', 'ses_tampered');
    session.addEvent({ type: 'input', content: 'hello' });
    const tampered = session.getData();
    tampered.events[0].index = 4;
    const tamperedPath = join(directory, 'tampered.vrs');
    await writeFile(tamperedPath, JSON.stringify(tampered), 'utf8');

    await expect(Session.load(tamperedPath)).rejects.toThrow('contiguous index 0');
  });

  it('creates a stable debug export with counts, previews, and defensive events', () => {
    const session = new Session('debug-session', 'test-agent', 'ses_debug');
    session.addEvent({ type: 'input', content: 0, method: 'run' });
    session.addEvent({ type: 'tool_call', name: 'filesystem.readFile', arguments: { path: '/tmp/input' } });
    session.addEvent({ type: 'error', error: 'permission denied', method: 'run' });

    const debugExport = session.exportDebug();
    debugExport.events[0].content = 'mutated';

    expect(debugExport).toMatchObject({
      $schema: 'visreplay/debug/1.0',
      session: { sessionId: 'ses_debug', sessionName: 'debug-session' },
      summary: {
        eventCount: 3,
        errorCount: 1,
        firstError: { index: 2, message: 'permission denied' },
        eventCounts: { input: 1, tool_call: 1, error: 1, reasoning: 0, tool_result: 0, output: 0 }
      }
    });
    expect(debugExport.timeline[0].preview).toBe('0');
    expect(debugExport.timeline[1].preview).toBe('filesystem.readFile({"path":"/tmp/input"})');
    expect(session.getEvents()[0].content).toBe(0);
  });

  it('extracts decision records into debug export without changing session schema', async () => {
    const session = new Session('decision-export', 'test-agent', 'ses_decision');
    session.addEvent({ type: 'input', content: 'deploy' });
    session.addEvent({
      type: 'reasoning',
      content: 'go',
      metadata: {
        visreplay: {
          schema: 'visreplay/decision/1.0',
          kind: 'decision',
          believed: { tests: 'green' }
        }
      }
    });

    const debugExport = session.exportDebug();
    expect(debugExport.summary.decisionCount).toBe(1);
    expect(debugExport.decisions[0].decision.believed).toEqual({ tests: 'green' });
    expect(debugExport.decisions[0].index).toBe(1);
    expect(session.getData().$schema).toBe('visreplay/session/1.0');

    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'decision.vrs');
    await session.save(filePath);
    const loaded = await Session.load(filePath);
    expect(loaded.$schema).toBe('visreplay/session/1.0');
    expect(Session.fromData(loaded).exportDebug().summary.decisionCount).toBe(1);
  });

  it('does not count malformed visreplay metadata as decisions', () => {
    const session = new Session('malformed-decision', 'test-agent', 'ses_malformed');
    session.addEvent({
      type: 'reasoning',
      content: 'notes',
      metadata: { visreplay: { kind: 'decision' } }
    });

    const debugExport = session.exportDebug();
    expect(debugExport.summary.decisionCount).toBe(0);
    expect(debugExport.decisions).toEqual([]);
    expect(debugExport.events).toHaveLength(1);
  });

  it('constructs a usable independent session from validated data', () => {
    const original = new Session('source', 'test', 'ses_source');
    original.addEvent({ type: 'input', content: 'source-event' });

    const restored = Session.fromData(original.getData());
    restored.addEvent({ type: 'output', content: 'new-event' });

    expect(original.getEvents()).toHaveLength(1);
    expect(restored.getEvents()).toHaveLength(2);
  });

  it('sets endedAt to an ISO UTC timestamp on the first end() call', () => {
    const session = new Session('ended-once', 'test', 'ses_end');
    expect(session.getData().endedAt).toBeUndefined();

    const snapshot = session.end();
    expect(snapshot.endedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
    expect(new Date(snapshot.endedAt as string).toISOString()).toBe(snapshot.endedAt);
    expect(session.getData().endedAt).toBe(snapshot.endedAt);
  });

  it('leaves the original endedAt unchanged on a second end() call', () => {
    const session = new Session('ended-twice', 'test', 'ses_end_twice');
    const first = session.end();
    const second = session.end();

    expect(second.endedAt).toBe(first.endedAt);
  });

  it('round-trips endedAt through save and load', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'ended.vrs');
    const session = new Session('ended-persist', 'test', 'ses_end_persist');
    session.addEvent({ type: 'input', content: 'before-end' });
    const ended = session.end();
    await session.save(filePath);

    const loaded = await Session.load(filePath);
    expect(loaded.endedAt).toBe(ended.endedAt);
  });

  it('still appends events after end() without clearing endedAt', () => {
    const session = new Session('ended-then-log', 'test', 'ses_end_log');
    const ended = session.end();
    session.addEvent({ type: 'output', content: 'after-end' });

    expect(session.getData().endedAt).toBe(ended.endedAt);
    expect(session.getEvents()).toHaveLength(1);
    expect(session.getEvents()[0].content).toBe('after-end');
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'visreplay-session-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createRawSessionData(content: unknown): SessionData {
  return {
    $schema: 'visreplay/session/1.0',
    sessionId: 'ses_untrusted',
    sessionName: 'untrusted',
    agentType: 'test',
    startedAt: '2026-01-01T00:00:00.000Z',
    events: [{
      eventId: 'evt_untrusted',
      index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'input',
      content
    }]
  };
}
