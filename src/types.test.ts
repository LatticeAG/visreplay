import { describe, expect, it } from 'vitest';

import {
  cloneJsonSafe,
  compileRedactionPatterns,
  DEBUG_EXPORT_SCHEMA,
  DECISION_SCHEMA,
  isEventType,
  isIsoUtcTimestamp,
  isSessionData,
  isSessionEvent,
  REDACTED_VALUE,
  SESSION_SCHEMA,
  toJsonSafe
} from './types';

describe('shared VisReplay types and value helpers', () => {
  it('recognizes only the v1 event type vocabulary', () => {
    expect(isEventType('input')).toBe(true);
    expect(isEventType('tool_result')).toBe(true);
    expect(isEventType('checkpoint')).toBe(false);
    expect(isEventType(42)).toBe(false);
  });

  it('validates ISO UTC timestamps rather than accepting arbitrary dates', () => {
    expect(isIsoUtcTimestamp('2026-07-21T12:34:56.789Z')).toBe(true);
    expect(isIsoUtcTimestamp('2026-07-21T12:34:56Z')).toBe(true);
    expect(isIsoUtcTimestamp('2026-07-21T12:34:56+01:00')).toBe(false);
    expect(isIsoUtcTimestamp('2026-02-30T12:34:56.000Z')).toBe(false);
    expect(isIsoUtcTimestamp('not a date')).toBe(false);
  });

  it('turns non-JSON primitives into visible, stable markers', () => {
    const normalized = toJsonSafe({
      missing: undefined,
      big: 42n,
      nan: Number.NaN,
      operation: function calculate() { return 1; },
      marker: Symbol('trace')
    });

    expect(normalized).toEqual({
      big: '[BigInt: 42]',
      marker: '[Symbol: trace]',
      missing: '[undefined]',
      nan: '[Number: NaN]',
      operation: '[Function: calculate]'
    });
  });

  it('redacts matching keys recursively and handles circular references', () => {
    const secret: Record<string, unknown> = {
      apiKey: 'top-secret',
      nested: [{ TOKEN: 'nested-secret', visible: true }]
    };
    secret.self = secret;

    expect(toJsonSafe(secret, ['apikey', 'token'])).toEqual({
      apiKey: '[REDACTED]',
      nested: [{ TOKEN: '[REDACTED]', visible: true }],
      self: '[Circular]'
    });
  });

  it('redacts regex-matched property names and values without regex cursor leakage', () => {
    const pattern = /client[_-]?secret|sk-[A-Za-z0-9_-]{8,}/i;
    const normalized = toJsonSafe({
      clientSecret: 'visible-if-not-key-matched',
      text: 'first sk-abcdefghijklmnop and second sk-qrstuvwxyzabcdef',
      nested: { note: 'no secret here' }
    }, [], [pattern]);

    expect(normalized).toEqual({
      clientSecret: REDACTED_VALUE,
      text: `first ${REDACTED_VALUE} and second ${REDACTED_VALUE}`,
      nested: { note: 'no secret here' }
    });
    expect(pattern.lastIndex).toBe(0);
  });

  it('accepts JSON-friendly regex definitions and rejects malformed patterns early', () => {
    const normalized = toJsonSafe(
      { authorization: 'Bearer visible-token', sentence: 'bearer also-hidden' },
      [],
      [{ pattern: 'bearer\\s+[^\\s]+', flags: 'i' }]
    );

    expect(normalized).toEqual({
      authorization: REDACTED_VALUE,
      sentence: REDACTED_VALUE
    });
    expect(() => compileRedactionPatterns(['[not-valid'])).toThrow('Invalid redaction pattern at index 0');
  });

  it('returns a defensive JSON-safe clone without retaining nested references', () => {
    const original = { nested: { values: [1, 2] } };
    const clone = cloneJsonSafe(original) as typeof original;
    clone.nested.values.push(3);

    expect(original).toEqual({ nested: { values: [1, 2] } });
    expect(clone).toEqual({ nested: { values: [1, 2, 3] } });
  });

  it('validates complete event and session documents including contiguous indices', () => {
    const event = {
      eventId: 'evt_1',
      index: 0,
      timestamp: '2026-07-21T12:34:56.789Z',
      type: 'input' as const,
      content: 'deploy'
    };
    const session = {
      $schema: SESSION_SCHEMA,
      sessionId: 'ses_1',
      sessionName: 'type-validation',
      agentType: 'test',
      startedAt: '2026-07-21T12:34:56.789Z',
      events: [event]
    };

    expect(isSessionEvent(event)).toBe(true);
    expect(isSessionData(session)).toBe(true);
    expect(isSessionData({ ...session, events: [{ ...event, index: 1 }] })).toBe(false);
    expect(DEBUG_EXPORT_SCHEMA).toBe('visreplay/debug/1.0');
  });

  it('exposes the decision ledger schema constant', () => {
    expect(DECISION_SCHEMA).toBe('visreplay/decision/1.0');
  });

  it('rejects events that omit a payload required by their event type', () => {
    expect(isSessionEvent({
      eventId: 'evt_2',
      index: 0,
      timestamp: '2026-07-21T12:34:56.789Z',
      type: 'tool_call',
      name: 'filesystem.readFile'
    })).toBe(false);
  });
});
