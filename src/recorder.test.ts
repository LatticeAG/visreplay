import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LexReplay, VisReplay } from './recorder';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('VisReplay recorder', () => {
  it('uses v1 defaults and exposes manual event APIs as defensive snapshots', () => {
    const recorder = new VisReplay();
    recorder.recordReasoning('consider the deployment');
    recorder.recordToolCall('filesystem.readFile', { path: '/tmp/config.json' });
    recorder.recordToolResult({ enabled: true });

    const events = recorder.getEvents();
    events[1].arguments!.path = '/tmp/mutated';
    const session = recorder.getSession();
    session.sessionName = 'mutated';

    expect(recorder.getSession()).toMatchObject({
      $schema: 'visreplay/session/1.0',
      sessionName: 'unnamed-session',
      agentType: 'unknown'
    });
    expect(recorder.getEvents()).toMatchObject([
      { type: 'reasoning', index: 0, content: 'consider the deployment' },
      { type: 'tool_call', index: 1, name: 'filesystem.readFile', arguments: { path: '/tmp/config.json' } },
      { type: 'tool_result', index: 2, result: { enabled: true } }
    ]);
  });

  it('wraps synchronous methods without changing their receiver or return value', () => {
    class Counter {
      public count = 2;

      public add(amount: number): number {
        this.count += amount;
        return this.count;
      }
    }

    const recorder = new VisReplay({ sessionName: 'sync-proxy' });
    const counter = new Counter();
    const wrapped = recorder.wrap(counter);

    expect(wrapped.count).toBe(2);
    expect(wrapped.add(3)).toBe(5);
    expect(counter.count).toBe(5);
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'add', content: [3] },
      { type: 'output', method: 'add', content: 5 }
    ]);
  });

  it('records asynchronous fulfillment only after the wrapped promise settles', async () => {
    const recorder = new VisReplay({ sessionName: 'async-proxy' });
    const wrapped = recorder.wrap({
      async run(input: string): Promise<{ input: string }> {
        await Promise.resolve();
        return { input };
      }
    });

    const pending = wrapped.run('hello');
    expect(recorder.getEvents()).toMatchObject([{ type: 'input', method: 'run', content: ['hello'] }]);

    await expect(pending).resolves.toEqual({ input: 'hello' });
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'run', content: ['hello'] },
      { type: 'output', method: 'run', content: { input: 'hello' } }
    ]);
  });

  it('observes a native promise without replacing the caller-visible promise', async () => {
    let resolveOriginal: ((value: string) => void) | undefined;
    const original = new Promise<string>((resolve) => {
      resolveOriginal = resolve;
    });
    const recorder = new VisReplay();
    const wrapped = recorder.wrap({
      run(): Promise<string> {
        return original;
      }
    });

    const returned = wrapped.run();
    expect(returned).toBe(original);
    expect(recorder.getEvents()).toMatchObject([{ type: 'input', method: 'run' }]);

    resolveOriginal?.('complete');
    await expect(returned).resolves.toBe('complete');

    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'run' },
      { type: 'output', method: 'run', content: 'complete' }
    ]);
  });

  it('preserves a foreign thenable and records its later fulfillment', () => {
    let fulfill: ((value: string) => void) | undefined;
    let foreignObserverWasProbed = false;
    const foreignObserver: Record<string, unknown> = {};
    Object.defineProperty(foreignObserver, 'then', {
      get() {
        foreignObserverWasProbed = true;
        throw new Error('foreign observer must not be assimilated');
      }
    });
    const thenable = {
      then(onFulfilled: (value: string) => void): Record<string, unknown> {
        fulfill = onFulfilled;
        return foreignObserver;
      }
    };
    const recorder = new VisReplay();
    const wrapped = recorder.wrap({
      run() {
        return thenable;
      }
    });

    const returned = wrapped.run();
    expect(returned).toBe(thenable);
    expect(foreignObserverWasProbed).toBe(false);
    expect(recorder.getEvents()).toMatchObject([{ type: 'input', method: 'run' }]);

    fulfill?.('complete');
    expect(foreignObserverWasProbed).toBe(false);
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'run' },
      { type: 'output', method: 'run', content: 'complete' }
    ]);
  });

  it('treats a result with a throwing then getter as a synchronous return', () => {
    const getterFailure = new Error('then getter must not change the method result');
    const result: Record<string, unknown> = {};
    Object.defineProperty(result, 'then', {
      enumerable: true,
      get() {
        throw getterFailure;
      }
    });
    const recorder = new VisReplay();
    const wrapped = recorder.wrap({
      run() {
        return result;
      }
    });

    expect(wrapped.run()).toBe(result);
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'run' },
      { type: 'output', method: 'run', content: { then: '[Accessor]' } }
    ]);
  });

  it('records sync throws and async rejections while preserving the original failures', async () => {
    const syncFailure = new Error('sync failure');
    const asyncFailure = new Error('async failure');
    const recorder = new VisReplay();
    const wrapped = recorder.wrap({
      failSync(): never {
        throw syncFailure;
      },
      async failAsync(): Promise<void> {
        throw asyncFailure;
      }
    });

    expect(() => wrapped.failSync()).toThrow(syncFailure);
    await expect(wrapped.failAsync()).rejects.toBe(asyncFailure);
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'failSync' },
      { type: 'error', method: 'failSync', error: 'sync failure' },
      { type: 'input', method: 'failAsync' },
      { type: 'error', method: 'failAsync', error: 'async failure' }
    ]);
  });

  it('redacts default secret keys recursively before callers can inspect events', () => {
    const recorder = new VisReplay();
    recorder.recordToolCall('request', {
      authorization: 'Bearer hidden',
      nested: { ApiKey: 'also-hidden', visible: 'ok' }
    });
    recorder.recordToolResult({ token: 'never-visible', status: 'ok' });

    expect(recorder.getEvents()).toMatchObject([
      {
        arguments: {
          authorization: '[REDACTED]',
          nested: { ApiKey: '[REDACTED]', visible: 'ok' }
        }
      },
      { result: { token: '[REDACTED]', status: 'ok' } }
    ]);
  });

  it('redacts configured regex patterns in manual scalar and nested values', () => {
    const recorder = new VisReplay({
      redactKeys: [],
      redactPatterns: [
        /tenant_[A-Za-z0-9_-]+/g,
        { pattern: 'secret-[A-Za-z0-9_-]+', flags: 'i' }
      ]
    });

    recorder.recordReasoning('Connect tenant_acme with secret-internal');
    recorder.log({ type: 'error', method: 'tenant_connect', error: 'tenant_acme refused secret-internal' });

    expect(recorder.getEvents()).toMatchObject([
      { type: 'reasoning', content: 'Connect [REDACTED] with [REDACTED]' },
      { type: 'error', method: '[REDACTED]', error: '[REDACTED] refused [REDACTED]' }
    ]);
  });

  it('allows an explicit empty redaction list and safely records circular values', () => {
    const recorder = new VisReplay({ redactKeys: [] });
    const cyclic: Record<string, unknown> = { token: 'visible-by-choice', big: 9n };
    cyclic.self = cyclic;

    recorder.log({ type: 'output', content: cyclic });

    expect(recorder.getEvents()[0].content).toEqual({
      big: '[BigInt: 9]',
      self: '[Circular]',
      token: 'visible-by-choice'
    });
  });

  it('saves, reloads, and exports the stable debug report without synthetic events', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'recording.vrs');
    const recorder = new VisReplay({ sessionName: 'saved-recorder', agentType: 'test-agent' });
    recorder.log({ type: 'input', content: 'inspect' });
    recorder.log({ type: 'error', error: 'failed once' });
    await recorder.save(filePath);

    const loaded = await VisReplay.load(filePath);
    const debugExport = loaded.exportDebug();

    expect(loaded.getEvents()).toHaveLength(2);
    expect(debugExport).toMatchObject({
      $schema: 'visreplay/debug/1.0',
      session: { sessionName: 'saved-recorder', agentType: 'test-agent' },
      summary: { eventCount: 2, errorCount: 1, firstError: { index: 1, message: 'failed once' } }
    });
  });

  it('redacts loaded session data by default and retains an explicit opt-out', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'untrusted.vrs');
    await writeFile(filePath, JSON.stringify(createRawSessionData({
      token: 'default-secret',
      nested: { authorization: 'Bearer hidden' }
    })), 'utf8');

    const safe = await VisReplay.load(filePath);
    const visible = await VisReplay.load(filePath, { redactKeys: [] });

    expect(safe.getEvents()[0].content).toEqual({
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]' }
    });
    expect(JSON.stringify(safe.exportDebug())).not.toContain('default-secret');
    expect(visible.getEvents()[0].content).toEqual({
      token: 'default-secret',
      nested: { authorization: 'Bearer hidden' }
    });
  });

  it('keeps LexReplay as a compatibility alias and rejects invalid manual events', () => {
    expect(LexReplay).toBe(VisReplay);
    const recorder = new LexReplay({ sessionName: 'compatibility' });

    expect(() => recorder.log({ type: 'future_event', content: 'nope' } as never))
      .toThrow('Unknown event type');
  });

  it('marks endedAt once and still appends later log events', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'ended.vrs');
    const recorder = new VisReplay({ sessionName: 'ended-recorder', agentType: 'test' });
    recorder.log({ type: 'input', content: 'start' });
    const first = recorder.end();
    recorder.log({ type: 'output', content: 'after-end' });
    const second = recorder.end();
    await recorder.save(filePath);

    expect(second.endedAt).toBe(first.endedAt);
    expect(recorder.getEvents()).toHaveLength(2);
    const loaded = await VisReplay.load(filePath);
    expect(loaded.getSession().endedAt).toBe(first.endedAt);
  });

  it('returns wrapped method values when capture fails and reports the error', () => {
    const captured: Array<{ error: unknown; type: string }> = [];
    const recorder = new VisReplay({
      sessionName: 'capture-hook',
      onCaptureError(error, event) {
        captured.push({ error, type: event.type });
      }
    });
    const session = (recorder as unknown as { session: { addEvent: (event: unknown) => unknown } }).session;
    session.addEvent = () => {
      throw new Error('capture failed');
    };
    const wrapped = recorder.wrap({
      run(value: string): string {
        return `ok:${value}`;
      }
    });

    expect(wrapped.run('deploy')).toBe('ok:deploy');
    expect(captured).toEqual([
      { error: expect.objectContaining({ message: 'capture failed' }), type: 'input' },
      { error: expect.objectContaining({ message: 'capture failed' }), type: 'output' }
    ]);
    expect(recorder.getEvents()).toEqual([]);
  });

  it('swallows a throwing onCaptureError callback so wrap still returns', () => {
    const recorder = new VisReplay({
      onCaptureError() {
        throw new Error('observer exploded');
      }
    });
    const session = (recorder as unknown as { session: { addEvent: (event: unknown) => unknown } }).session;
    session.addEvent = () => {
      throw new Error('capture failed');
    };
    const wrapped = recorder.wrap({
      ping(): number {
        return 7;
      }
    });

    expect(wrapped.ping()).toBe(7);
  });

  it('records a decision as reasoning with visreplay decision metadata', () => {
    const recorder = new VisReplay({ sessionName: 'decision' });
    recorder.log({ type: 'input', content: 'deploy' });
    const event = recorder.recordDecision({
      believed: { tests: 'green' },
      assumed: { staging: 'isolated' },
      relatedEventIndex: 0,
      summary: 'ship it'
    });

    expect(event.type).toBe('reasoning');
    expect(event.content).toBe('ship it');
    expect(event.metadata).toMatchObject({
      visreplay: {
        schema: 'visreplay/decision/1.0',
        kind: 'decision',
        believed: { tests: 'green' },
        relatedEventIndex: 0
      }
    });
    expect(recorder.getSession().$schema).toBe('visreplay/session/1.0');
  });

  it('redacts secret keys inside believed before getEvents', () => {
    const recorder = new VisReplay();
    recorder.recordDecision({
      believed: { token: 'super-secret', status: 'green' }
    });

    expect(recorder.getEvents()[0].metadata).toMatchObject({
      visreplay: {
        kind: 'decision',
        believed: { token: '[REDACTED]', status: 'green' }
      }
    });
  });

  it('rejects decision confidence outside 0 to 1', () => {
    const recorder = new VisReplay();
    expect(() => recorder.recordDecision({ believed: { ok: true }, confidence: 1.5 }))
      .toThrow('Decision confidence must be a finite number between 0 and 1');
  });

  it('rejects reserved metadata.visreplay on recordDecision', () => {
    const recorder = new VisReplay();
    expect(() => recorder.recordDecision({
      believed: { ok: true },
      metadata: { visreplay: { kind: 'nope' } }
    })).toThrow('metadata.visreplay is reserved for VisReplay');
  });

  it('rejects relatedEventIndex outside the current session bounds', () => {
    const recorder = new VisReplay();
    expect(() => recorder.recordDecision({ believed: { ok: true }, relatedEventIndex: 0 }))
      .toThrow('relatedEventIndex 0 is outside the session bounds');
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'visreplay-recorder-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createRawSessionData(content: unknown): Record<string, unknown> {
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
