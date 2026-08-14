import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as visreplay from './index';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('public package exports', () => {
  it('exports the primary SDK, session, and player runtime classes', () => {
    expect(visreplay.VisReplay).toBeTypeOf('function');
    expect(visreplay.Session).toBeTypeOf('function');
    expect(visreplay.Player).toBeTypeOf('function');
  });

  it('keeps LexReplay as a compatibility alias for VisReplay', () => {
    expect(visreplay.LexReplay).toBe(visreplay.VisReplay);
  });

  it('exports the stable v1 schemas and event type constants', () => {
    expect(visreplay.SESSION_SCHEMA).toBe('visreplay/session/1.0');
    expect(visreplay.DEBUG_EXPORT_SCHEMA).toBe('visreplay/debug/1.0');
    expect(visreplay.DECISION_SCHEMA).toBe('visreplay/decision/1.0');
    expect(visreplay.EVENT_TYPES).toEqual([
      'input',
      'reasoning',
      'tool_call',
      'tool_result',
      'output',
      'error'
    ]);
  });

  it('records manual events through the package barrel', () => {
    const recorder = new visreplay.VisReplay({ sessionName: 'barrel-recording', agentType: 'test' });
    const event = recorder.log({ type: 'input', content: 'inspect exports' });

    expect(event.index).toBe(0);
    expect(event.eventId).toMatch(/^evt_/);
    expect(recorder.getEvents()).toEqual([event]);
  });

  it('replays an in-memory public Session without invoking an agent', async () => {
    const session = new visreplay.Session('barrel-playback', 'test');
    session.addEvent({ type: 'output', content: 'recorded result' });
    const output: string[] = [];
    const player = new visreplay.Player({ write: (line) => output.push(line) });
    player.setSession(session.getData());

    const result = await player.play({ auto: true });

    expect(result).toEqual({ played: 1, cursor: 0, completed: true });
    expect(output).toContain('Content: recorded result');
  });

  it('loads a saved recorder and exports the debug report through public APIs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visreplay-index-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'barrel.vrs');
    const recorder = new visreplay.VisReplay({ sessionName: 'barrel-export', agentType: 'test' });
    recorder.recordToolCall('filesystem.readFile', { path: '/tmp/input.txt' });
    await recorder.save(filePath);

    const loaded = await visreplay.VisReplay.load(filePath);
    const debugExport = loaded.exportDebug();

    expect(debugExport.$schema).toBe('visreplay/debug/1.0');
    expect(debugExport.session.sessionName).toBe('barrel-export');
    expect(debugExport.summary.eventCounts.tool_call).toBe(1);
    expect(debugExport.timeline[0]).toMatchObject({ name: 'filesystem.readFile' });
  });

  it('exports the public event guard for consumers validating untrusted data', () => {
    expect(visreplay.isEventType('tool_result')).toBe(true);
    expect(visreplay.isEventType('checkpoint')).toBe(false);
  });

  it('exports comparison, WebSocket, and report-rendering extensions without CLI execution', () => {
    expect(visreplay.compareSessions).toBeTypeOf('function');
    expect(visreplay.compareSessionFiles).toBeTypeOf('function');
    expect(visreplay.attachWebSocket).toBeTypeOf('function');
    expect(visreplay.renderDebugViewer).toBeTypeOf('function');
    expect(visreplay.renderHtmlTimeline).toBeTypeOf('function');
    expect(visreplay.renderMarkdownReport).toBeTypeOf('function');
    expect(visreplay.writeTextAtomically).toBeTypeOf('function');

    const session = new visreplay.Session('barrel-comparison', 'test');
    session.addEvent({ type: 'input', content: 'same' });
    expect(visreplay.compareSessions(session.getData(), session.getData()).equal).toBe(true);
    expect(visreplay.renderMarkdownReport(session.exportDebug())).toContain('# VisReplay Debug Report');
  });

  it('does not import the CLI module from the public barrel', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/cli['"]/);
  });

  it('exports interop helpers from the public barrel', () => {
    expect(visreplay.exportInterop).toBeTypeOf('function');
    expect(visreplay.renderInterop).toBeTypeOf('function');

    const recorder = new visreplay.VisReplay({ sessionName: 'barrel-interop', agentType: 'test' });
    recorder.log({ type: 'input', content: 'inspect interop' });
    const result = visreplay.exportInterop(recorder.getSession(), 'otlp');

    expect(result.$schema).toBe('visreplay/interop/1.0');
    expect(JSON.stringify(result.document)).toContain('resourceSpans');
  });
});
