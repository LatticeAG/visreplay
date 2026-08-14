import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compareSessionFiles, compareSessions, diffSessions } from './diff';
import { Session } from './session';
import { SessionData, SessionEvent } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('compareSessions', () => {
  it('treats independently generated IDs and timestamps as non-semantic by default', () => {
    const baseline = createSessionData();
    const candidate = createSessionData({
      sessionId: 'session_candidate',
      startedAt: '2026-03-01T00:00:00.000Z',
      eventIds: ['evt_candidate_0', 'evt_candidate_1'],
      timestamps: ['2026-03-01T00:00:01.000Z', '2026-03-01T00:00:02.000Z']
    });

    const comparison = compareSessions(baseline, candidate);

    expect(comparison.equal).toBe(true);
    expect(comparison.summary).toEqual({
      baselineEventCount: 2,
      candidateEventCount: 2,
      unchanged: 2,
      changed: 0,
      added: 0,
      removed: 0,
      metadataChanges: 0
    });
    expect(comparison.events.map((event) => event.kind)).toEqual(['unchanged', 'unchanged']);

    comparison.events[0].baseline!.content = 'mutated diff snapshot';
    expect(baseline.events[0].content).toBe('deploy');
  });

  it('reports metadata, changed fields, additions, and removals deterministically', () => {
    const baseline = createSessionData({
      sessionName: 'baseline',
      events: [
        inputEvent(0, 'deploy'),
        outputEvent(1, 'complete'),
        outputEvent(2, 'baseline tail')
      ]
    });
    const candidate = createSessionData({
      sessionName: 'candidate',
      events: [
        inputEvent(0, 'deploy'),
        outputEvent(1, 'different completion')
      ]
    });

    const comparison = diffSessions(baseline, candidate, { includeUnchanged: false });

    expect(comparison.equal).toBe(false);
    expect(comparison.metadata).toEqual([
      { field: 'sessionName', baseline: 'baseline', candidate: 'candidate' }
    ]);
    expect(comparison.summary).toMatchObject({
      unchanged: 1,
      changed: 1,
      added: 0,
      removed: 1,
      metadataChanges: 1
    });
    expect(comparison.events).toHaveLength(2);
    expect(comparison.events[0]).toMatchObject({
      kind: 'changed',
      baselineIndex: 1,
      candidateIndex: 1,
      changes: [{ field: 'content', baseline: 'complete', candidate: 'different completion' }]
    });
    expect(comparison.events[1]).toMatchObject({
      kind: 'removed',
      baselineIndex: 2,
      changes: []
    });

    const withAddition = compareSessions(candidate, baseline, { includeUnchanged: false });
    expect(withAddition.summary).toMatchObject({ changed: 1, added: 1, removed: 0 });
    expect(withAddition.events.at(-1)).toMatchObject({ kind: 'added', candidateIndex: 2 });
  });

  it('can include generated timestamps and identifiers when a forensic comparison needs them', () => {
    const baseline = createSessionData();
    const candidate = createSessionData({
      sessionId: 'session_candidate',
      startedAt: '2026-04-01T00:00:00.000Z',
      eventIds: ['evt_candidate_0', 'evt_candidate_1'],
      timestamps: ['2026-04-01T00:00:01.000Z', '2026-04-01T00:00:02.000Z']
    });

    const comparison = compareSessions(baseline, candidate, {
      compareIdentifiers: true,
      compareTimestamps: true,
      includeUnchanged: false
    });

    expect(comparison.equal).toBe(false);
    expect(comparison.metadata.map((change) => change.field)).toEqual(['startedAt', 'sessionId']);
    expect(comparison.events).toHaveLength(2);
    expect(comparison.events[0].changes.map((change) => change.field)).toEqual(['timestamp', 'eventId']);
  });

  it('rejects malformed recordings instead of producing a partial diff', () => {
    const valid = createSessionData();

    expect(() => compareSessions({ events: [] } as unknown as SessionData, valid))
      .toThrow('baseline value must be a valid VisReplay session');
    expect(() => compareSessions(valid, { events: [] } as unknown as SessionData))
      .toThrow('candidate value must be a valid VisReplay session');
  });

  it('loads and compares two saved recordings through the file helper', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'visreplay-diff-'));
    temporaryDirectories.push(directory);
    const baselinePath = join(directory, 'baseline.vrs');
    const candidatePath = join(directory, 'candidate.vrs');
    const baseline = new Session('file-comparison', 'test-agent');
    const candidate = new Session('file-comparison', 'test-agent');
    baseline.addEvent({ type: 'input', content: 'deploy' });
    candidate.addEvent({ type: 'input', content: 'deploy' });
    await Promise.all([baseline.save(baselinePath), candidate.save(candidatePath)]);

    await expect(compareSessionFiles(baselinePath, candidatePath)).resolves.toMatchObject({
      equal: true,
      summary: { unchanged: 1, changed: 0, added: 0, removed: 0 }
    });
  });

  it('treats two empty recordings as equal', () => {
    const empty = createSessionData({ events: [] });
    const comparison = compareSessions(empty, empty);

    expect(comparison.equal).toBe(true);
    expect(comparison.summary).toMatchObject({
      baselineEventCount: 0,
      candidateEventCount: 0,
      unchanged: 0,
      changed: 0,
      added: 0,
      removed: 0
    });
    expect(comparison.events).toEqual([]);
  });

  it('omits unchanged event pairs when includeUnchanged is false', () => {
    const baseline = createSessionData();
    const comparison = compareSessions(baseline, baseline, { includeUnchanged: false });

    expect(comparison.equal).toBe(true);
    expect(comparison.summary.unchanged).toBe(2);
    expect(comparison.events).toEqual([]);
  });

  it('is aliased as diffSessions and rejects oversized files through compareSessionFiles', async () => {
    expect(diffSessions).toBe(compareSessions);

    const directory = await mkdtemp(join(tmpdir(), 'visreplay-diff-limit-'));
    temporaryDirectories.push(directory);
    const baselinePath = join(directory, 'baseline.vrs');
    const candidatePath = join(directory, 'candidate.vrs');
    const session = new Session('limit-comparison', 'test-agent');
    session.addEvent({ type: 'input', content: 'deploy' });
    await Promise.all([session.save(baselinePath), session.save(candidatePath)]);

    await expect(compareSessionFiles(baselinePath, candidatePath, { maxFileBytes: 8 }))
      .rejects.toThrow('exceeds the 8-byte limit');
  });
});

interface SessionDataOverrides {
  sessionId?: string;
  sessionName?: string;
  startedAt?: string;
  eventIds?: [string, string];
  timestamps?: [string, string];
  events?: SessionEvent[];
}

function createSessionData(overrides: SessionDataOverrides = {}): SessionData {
  const eventIds = overrides.eventIds ?? ['evt_baseline_0', 'evt_baseline_1'];
  const timestamps = overrides.timestamps ?? ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'];
  const events = overrides.events ?? [
    inputEvent(0, 'deploy', eventIds[0], timestamps[0]),
    outputEvent(1, 'complete', eventIds[1], timestamps[1])
  ];

  return {
    $schema: 'visreplay/session/1.0',
    sessionId: overrides.sessionId ?? 'session_baseline',
    sessionName: overrides.sessionName ?? 'comparison-test',
    agentType: 'test-agent',
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    events
  };
}

function inputEvent(index: number, content: unknown, eventId?: string, timestamp?: string): SessionEvent {
  return {
    eventId: eventId ?? `evt_input_${index}`,
    index,
    timestamp: timestamp ?? `2026-01-01T00:00:0${index + 1}.000Z`,
    type: 'input',
    content
  };
}

function outputEvent(index: number, content: unknown, eventId?: string, timestamp?: string): SessionEvent {
  return {
    eventId: eventId ?? `evt_output_${index}`,
    index,
    timestamp: timestamp ?? `2026-01-01T00:00:0${index + 1}.000Z`,
    type: 'output',
    content
  };
}
