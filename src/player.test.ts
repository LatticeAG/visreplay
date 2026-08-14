import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Player, formatEvent } from './player';
import { Session } from './session';
import { SessionData, SessionEvent } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Player', () => {
  it('requires a session before replay navigation begins', () => {
    const player = new Player({ write: () => undefined });

    expect(() => player.getSession()).toThrow('No session loaded');
    expect(() => player.stepNext()).toThrow('No session loaded');
    expect(() => player.rewind()).toThrow('No session loaded');
  });

  it('navigates forward, backward, and directly to an event', () => {
    const player = new Player({ write: () => undefined });
    player.setSession(createSessionData());

    expect(player.cursor).toBe(-1);
    expect(player.stepNext()?.index).toBe(0);
    expect(player.currentEvent?.type).toBe('input');
    expect(player.stepNext()?.index).toBe(1);
    expect(player.stepPrevious()?.index).toBe(0);
    expect(player.stepPrevious()).toBeNull();
    expect(player.cursor).toBe(-1);
    expect(player.jumpTo(1).type).toBe('output');
    expect(() => player.jumpTo(2)).toThrow(RangeError);
  });

  it('exposes explicit step-through aliases with stable boundary semantics', () => {
    const player = new Player({ write: () => undefined });
    player.setSession(createSessionData());

    expect(player.stepForward()?.index).toBe(0);
    expect(player.stepForward()?.index).toBe(1);
    expect(player.stepForward()).toBeNull();
    expect(player.stepBackward()?.index).toBe(0);
    player.reset();

    expect(player.cursor).toBe(-1);
    expect(player.stepBackward()).toBeNull();
    expect(player.cursor).toBe(-1);
  });

  it('keeps its loaded session isolated from caller and reader mutations', () => {
    const source = createSessionData();
    const player = new Player({ write: () => undefined });
    player.setSession(source);
    source.events[0].content = 'mutated source';

    const snapshot = player.getSession();
    snapshot.events[0].content = 'mutated snapshot';

    expect(player.getSession().events[0].content).toBe('deploy');
  });

  it('plays all events automatically without waiting for terminal input', async () => {
    const output: string[] = [];
    const observed: string[] = [];
    const delays: number[] = [];
    const player = new Player({ write: (line) => output.push(line), autoDelayMs: 3 });
    player.setSession(createSessionData());

    const result = await player.play({
      auto: true,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onEvent: (event) => {
        observed.push(event.type);
      }
    });

    expect(result).toEqual({ played: 2, cursor: 1, completed: true });
    expect(observed).toEqual(['input', 'output']);
    expect(delays).toEqual([3]);
    expect(output).toContain('Content: deploy');
    expect(output).toContain('Content: complete');
    expect(output).toContain('--- End of Session ---');
  });

  it('stops an interactive replay when the pause handler returns quit', async () => {
    const output: string[] = [];
    const player = new Player({ write: (line) => output.push(line) });
    player.setSession(createSessionData());

    const result = await player.play({
      pause: async () => 'quit'
    });

    expect(result).toEqual({ played: 1, cursor: 0, completed: false });
    expect(output).toContain('Content: deploy');
    expect(output).not.toContain('Content: complete');
    expect(output).not.toContain('--- End of Session ---');
  });

  it('holds playback until resume and rejects a concurrent replay or session replacement', async () => {
    const output: string[] = [];
    const player = new Player({ write: (line) => output.push(line) });
    player.setSession(createSessionData());
    player.pause();

    const firstPlayback = player.play({ auto: true });
    await Promise.resolve();

    expect(player.state).toBe('paused');
    expect(player.isPaused).toBe(true);
    expect(player.isPlaying).toBe(false);
    expect(output).toEqual([]);
    await expect(player.play({ auto: true })).rejects.toThrow('Playback is already in progress');
    expect(() => player.setSession(createSessionData())).toThrow('Cannot replace a session while playback is in progress');

    player.resume();
    await expect(firstPlayback).resolves.toEqual({ played: 2, cursor: 1, completed: true });
    expect(player.state).toBe('completed');
    expect(player.isPaused).toBe(false);

    player.reset();
    player.pause();
    expect(player.state).toBe('paused');
  });

  it('honours a pause requested while auto playback is running', async () => {
    const player = new Player({ write: () => undefined });
    player.setSession(createSessionData());
    let observeFirstEvent: (() => void) | undefined;
    const firstEvent = new Promise<void>((resolve) => {
      observeFirstEvent = resolve;
    });

    const playback = player.play({
      auto: true,
      onEvent: (event) => {
        if (event.index === 0) {
          player.pause();
          observeFirstEvent?.();
        }
      }
    });

    await firstEvent;
    expect(player.cursor).toBe(0);
    expect(player.isPaused).toBe(true);
    player.resume();

    await expect(playback).resolves.toEqual({ played: 2, cursor: 1, completed: true });
  });

  it('loads a saved session file and resets the cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visreplay-player-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'session.vrs');
    const session = new Session('saved-session', 'test-agent');
    session.addEvent({ type: 'input', content: 'from disk' });
    await session.save(filePath);

    const output: string[] = [];
    const player = new Player({ write: (line) => output.push(line) });
    await player.load(filePath);

    expect(player.cursor).toBe(-1);
    expect(player.getSession().sessionName).toBe('saved-session');
    expect(player.stepNext()?.content).toBe('from disk');
    expect(output[0]).toBe('Loaded session: saved-session (1 events)');
  });

  it('redacts default keys while loading or restoring session data, with an opt-out', async () => {
    const source = createSessionData();
    source.events[0].content = {
      token: 'default-secret',
      nested: { authorization: 'Bearer hidden' }
    };
    const directory = await mkdtemp(join(tmpdir(), 'visreplay-player-redaction-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'untrusted.vrs');
    await writeFile(filePath, JSON.stringify(source), 'utf8');

    const loaded = new Player({ write: () => undefined });
    await loaded.load(filePath);
    const restored = new Player({ write: () => undefined });
    restored.setSession(source);
    const visible = new Player({ write: () => undefined, redactKeys: [] });
    visible.setSession(source);

    expect(loaded.getSession().events[0].content).toEqual({
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]' }
    });
    expect(restored.getSession().events[0].content).toEqual({
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]' }
    });
    expect(visible.getSession().events[0].content).toEqual({
      token: 'default-secret',
      nested: { authorization: 'Bearer hidden' }
    });
  });

  it('passes configured text redaction patterns through session restoration', () => {
    const source = createSessionData();
    source.events[0].content = 'credential=super-secret-value';
    const player = new Player({
      write: () => undefined,
      redactKeys: [],
      redactPatterns: [/super-secret-value/]
    });

    player.setSession(source);

    expect(player.getSession().events[0].content).toBe('credential=[REDACTED]');
  });

  it('formats canonical payload fields alongside legacy event fields', () => {
    const event = {
      type: 'tool_call',
      timestamp: '2026-01-01T00:00:00.000Z',
      index: 3,
      payload: {
        name: 'filesystem.writeFile',
        arguments: { path: '/tmp/result.txt' }
      },
      latencyMs: 42
    } as unknown as SessionEvent;

    expect(formatEvent(event)).toEqual([
      '[2026-01-01T00:00:00.000Z] EVENT: TOOL_CALL (Index: 3)',
      'Name: filesystem.writeFile',
      'Arguments: {\n  "path": "/tmp/result.txt"\n}',
      'Latency: 42ms'
    ]);
  });

  it('renders populated falsy values and session metadata instead of hiding them', () => {
    const event = {
      type: 'output',
      timestamp: '2026-01-01T00:00:00.000Z',
      index: 4,
      eventId: 'evt_4',
      content: 0,
      method: '',
      result: false,
      metadata: {}
    } as unknown as SessionEvent;

    expect(formatEvent(event)).toEqual([
      '[2026-01-01T00:00:00.000Z] EVENT: OUTPUT (Index: 4)',
      'Event ID: evt_4',
      'Content: 0',
      'Method: ',
      'Result: false',
      'Metadata: {}'
    ]);
  });

  it('renders explicit canonical and legacy null payload values', () => {
    const canonical = {
      type: 'output',
      timestamp: '2026-01-01T00:00:00.000Z',
      index: 5,
      content: null,
      result: null
    } as unknown as SessionEvent;
    const legacy = {
      type: 'output',
      timestamp: '2026-01-01T00:00:00.000Z',
      index: 6,
      payload: { content: null, result: null }
    } as unknown as SessionEvent;

    expect(formatEvent(canonical)).toEqual([
      '[2026-01-01T00:00:00.000Z] EVENT: OUTPUT (Index: 5)',
      'Content: null',
      'Result: null'
    ]);
    expect(formatEvent(legacy)).toEqual([
      '[2026-01-01T00:00:00.000Z] EVENT: OUTPUT (Index: 6)',
      'Content: null',
      'Result: null'
    ]);
  });

  it('rejects invalid sessions and invalid playback delays', () => {
    const player = new Player({ write: () => undefined });

    expect(() => player.setSession({ sessionName: 'invalid' } as SessionData)).toThrow(TypeError);
    expect(() => new Player({ autoDelayMs: -1 })).toThrow('Playback delay must be a non-negative finite number');
  });

  it('compares equal sessions and reports a changed content field', () => {
    const baseline = new Player({ write: () => undefined });
    const candidate = new Player({ write: () => undefined });
    baseline.setSession(createSessionData());
    candidate.setSession(createSessionData());
    expect(baseline.compareWith(candidate).equal).toBe(true);

    const changed = createSessionData();
    changed.events[1].content = 'different';
    candidate.setSession(changed);
    const comparison = baseline.compareWith(candidate.getSession());
    expect(comparison.equal).toBe(false);
    expect(comparison.events[1]).toMatchObject({
      kind: 'changed',
      changes: [{ field: 'content', baseline: 'complete', candidate: 'different' }]
    });
  });

  it('honours maxFileBytes when loading a session file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visreplay-player-limit-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'session.vrs');
    const session = new Session('limited', 'test');
    session.addEvent({ type: 'input', content: 'too-big-for-tiny-limit' });
    await session.save(filePath);

    const player = new Player({ write: () => undefined, maxFileBytes: 8 });
    await expect(player.load(filePath)).rejects.toThrow('exceeds the 8-byte limit');
  });
});

function createSessionData(): SessionData {
  return {
    $schema: 'visreplay/session/1.0',
    sessionId: 'session_player_test',
    sessionName: 'player-test',
    startedAt: '2026-01-01T00:00:00.000Z',
    agentType: 'test-agent',
    meta: {},
    checksum: 'sha256:test',
    events: [
      {
        eventId: 'evt_player_0',
        type: 'input',
        timestamp: '2026-01-01T00:00:00.000Z',
        index: 0,
        content: 'deploy'
      },
      {
        eventId: 'evt_player_1',
        type: 'output',
        timestamp: '2026-01-01T00:00:01.000Z',
        index: 1,
        content: 'complete'
      }
    ]
  } as unknown as SessionData;
}
