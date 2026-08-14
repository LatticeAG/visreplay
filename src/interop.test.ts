import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { exportInterop, renderInterop } from './interop';
import { VisReplay } from './recorder';
import { SessionData, SessionEvent } from './types';

describe('interop exporters', () => {
  it('starts a Langfuse batch with trace-create and spans a tool_call', () => {
    const result = exportInterop(sampleSession(), 'langfuse');
    const document = result.document as { batch: Array<{ type: string; body: Record<string, unknown> }> };

    expect(document.batch[0].type).toBe('trace-create');
    expect(document.batch.some((item) => item.type === 'span-create' && item.body.name === 'deploy')).toBe(true);
  });

  it('copies decision metadata into Langfuse event metadata', () => {
    const result = exportInterop(sampleSession(), 'langfuse');
    const document = result.document as { batch: Array<{ body: { name?: string; metadata?: { visreplay?: { decision?: { kind: string } } } } }> };
    const decisionItem = document.batch.find((item) => item.body.name === 'decision');

    expect(decisionItem?.body.metadata?.visreplay?.decision?.kind).toBe('decision');
  });

  it('emits a stable 32-hex OTLP traceId and 16-hex spanId', () => {
    const session = sampleSession();
    const first = exportInterop(session, 'otlp');
    const second = exportInterop(session, 'otlp');
    const firstDoc = first.document as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }> }>;
    };
    const span = firstDoc.resourceSpans[0].scopeSpans[0].spans[0];
    const expectedTrace = createHash('sha256').update(session.sessionId, 'utf8').digest().subarray(0, 16).toString('hex');
    const expectedSpan = createHash('sha256').update(session.events[0].eventId, 'utf8').digest().subarray(0, 8).toString('hex');

    expect(span.traceId).toBe(expectedTrace);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toBe(expectedSpan);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(first.document)).toBe(JSON.stringify(second.document));
  });

  it('omits invented usage attributes from OTLP spans', () => {
    const session = sampleSession({
      events: [
        event(0, 'input', { content: 'go', method: 'run' }),
        event(1, 'output', { content: 'done', method: 'run' })
      ]
    });
    const json = JSON.stringify(exportInterop(session, 'otlp').document);
    expect(json).not.toContain('gen_ai.usage');
    expect(json).not.toContain('prompt_tokens');
    expect(json).not.toContain('completion_tokens');
  });

  it('builds a LangSmith array of one chain run plus the specified children', () => {
    const result = exportInterop(sampleSession(), 'langsmith');
    const runs = result.document as Array<{ run_type: string; id: string }>;
    // chain + input + decision + paired tool + output + error = 6
    expect(runs[0]).toMatchObject({ id: 'ses_interop', run_type: 'chain' });
    expect(runs).toHaveLength(6);
    expect(runs.filter((run) => run.run_type === 'tool')).toHaveLength(1);
  });

  it('keeps redacted secrets in all three vendor documents', () => {
    const recorder = new VisReplay();
    recorder.recordDecision({ believed: { token: 'super-secret', tests: 'green' } });
    recorder.recordToolCall('deploy', { apiKey: 'also-secret' });
    const session = recorder.getSession();

    for (const format of ['langfuse', 'otlp', 'langsmith'] as const) {
      const json = JSON.stringify(exportInterop(session, format).document);
      expect(json).toContain('[REDACTED]');
      expect(json).not.toContain('super-secret');
      expect(json).not.toContain('also-secret');
    }
  });

  it('throws when the input is not valid session data', () => {
    expect(() => exportInterop({ events: [] } as unknown as SessionData, 'otlp'))
      .toThrow('The session value must be a valid VisReplay session');
  });

  it('warns on unpaired tool_result events', () => {
    const session = sampleSession({
      events: [
        event(0, 'input', { content: 'go' }),
        event(1, 'tool_result', { result: { ok: true } })
      ]
    });
    const result = exportInterop(session, 'langfuse');
    expect(result.warnings.some((warning) => warning.includes('unpaired tool_result at index 1'))).toBe(true);
    const document = result.document as { batch: Array<{ type: string; body: { name?: string } }> };
    expect(document.batch.some((item) => item.body.name === 'tool_result')).toBe(true);
  });

  it('renderInterop returns vendor JSON with a trailing newline', () => {
    const rendered = renderInterop(sampleSession(), 'otlp');
    expect(rendered.endsWith('\n')).toBe(true);
    expect(JSON.parse(rendered).resourceSpans).toBeDefined();
  });
});

function sampleSession(overrides: Partial<SessionData> = {}): SessionData {
  const events = overrides.events ?? [
    event(0, 'input', { content: 'deploy staging', method: 'run' }),
    event(1, 'reasoning', {
      content: 'ship it',
      metadata: {
        visreplay: {
          schema: 'visreplay/decision/1.0',
          kind: 'decision',
          believed: { tests: 'green', token: '[REDACTED]' }
        }
      }
    }),
    event(2, 'tool_call', { name: 'deploy', arguments: { environment: 'staging' } }),
    event(3, 'tool_result', { result: { status: 'ok' } }),
    event(4, 'output', { content: 'complete', method: 'run' }),
    event(5, 'error', { error: 'canary failed', method: 'run' })
  ];

  return {
    $schema: 'visreplay/session/1.0',
    sessionId: 'ses_interop',
    sessionName: 'interop',
    agentType: 'test-agent',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
    events
  };
}

function event(index: number, type: SessionEvent['type'], rest: Partial<SessionEvent>): SessionEvent {
  return {
    eventId: `evt_${index}`,
    index,
    timestamp: `2026-01-01T00:00:0${index}.000Z`,
    type,
    ...rest
  } as SessionEvent;
}
