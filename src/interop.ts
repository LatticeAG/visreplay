import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  DecisionRecord,
  isDecisionVisreplay,
  isSessionData,
  SessionData,
  SessionEvent
} from './types';

export type InteropFormat = 'langfuse' | 'otlp' | 'langsmith';

export interface InteropExportResult {
  format: InteropFormat;
  $schema: 'visreplay/interop/1.0';
  source: {
    sessionId: string;
    sessionName: string;
    agentType: string;
    eventCount: number;
    decisionCount: number;
  };
  warnings: string[];
  document: unknown;
}

interface ToolPairs {
  resultByCallIndex: Map<number, SessionEvent>;
  callIndexByResultIndex: Map<number, number>;
  unpairedResults: SessionEvent[];
}

/**
 * Transform a validated VisReplay session into a vendor document. This never
 * opens a network connection; the caller writes or posts the file.
 */
export function exportInterop(session: SessionData, format: InteropFormat): InteropExportResult {
  if (!isSessionData(session)) {
    throw new TypeError('The session value must be a valid VisReplay session');
  }
  if (format !== 'langfuse' && format !== 'otlp' && format !== 'langsmith') {
    throw new TypeError(`Unknown interop format: ${String(format)}`);
  }

  const warnings: string[] = [];
  const pairs = pairToolEvents(session.events);
  for (const result of pairs.unpairedResults) {
    warnings.push(`unpaired tool_result at index ${result.index}`);
  }
  if (session.events.some((event) => event.type === 'reasoning')) {
    warnings.push('v1 event types cannot encode model name; omitted gen_ai.request.model');
  }

  const decisions = session.events.filter((event) => decisionOf(event) !== undefined);
  const document = format === 'langfuse'
    ? buildLangfuse(session, pairs, warnings)
    : format === 'otlp'
      ? buildOtlp(session, pairs, warnings)
      : buildLangsmith(session, pairs, warnings);

  return {
    format,
    $schema: 'visreplay/interop/1.0',
    source: {
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      agentType: session.agentType,
      eventCount: session.events.length,
      decisionCount: decisions.length
    },
    warnings,
    document
  };
}

/** Vendor JSON only, pretty-printed, with a trailing newline. */
export function renderInterop(session: SessionData, format: InteropFormat): string {
  return `${JSON.stringify(exportInterop(session, format).document, null, 2)}\n`;
}

function pairToolEvents(events: SessionEvent[]): ToolPairs {
  const consumedResults = new Set<number>();
  const resultByCallIndex = new Map<number, SessionEvent>();
  const callIndexByResultIndex = new Map<number, number>();

  for (const event of events) {
    if (event.type !== 'tool_call') {
      continue;
    }
    const result = events.find((candidate) => (
      candidate.type === 'tool_result'
      && candidate.index > event.index
      && !consumedResults.has(candidate.index)
    ));
    if (result === undefined) {
      continue;
    }
    consumedResults.add(result.index);
    resultByCallIndex.set(event.index, result);
    callIndexByResultIndex.set(result.index, event.index);
  }

  return {
    resultByCallIndex,
    callIndexByResultIndex,
    unpairedResults: events.filter((event) => event.type === 'tool_result' && !consumedResults.has(event.index))
  };
}

function decisionOf(event: SessionEvent): DecisionRecord | undefined {
  return event.metadata !== undefined && isDecisionVisreplay(event.metadata.visreplay)
    ? event.metadata.visreplay
    : undefined;
}

function firstOfType(events: SessionEvent[], type: SessionEvent['type']): SessionEvent | undefined {
  return events.find((event) => event.type === type);
}

function lastOfType(events: SessionEvent[], type: SessionEvent['type']): SessionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) {
      return events[index];
    }
  }
  return undefined;
}

function buildLangfuse(session: SessionData, pairs: ToolPairs, _warnings: string[]): unknown {
  const firstInput = firstOfType(session.events, 'input');
  const lastOutput = lastOfType(session.events, 'output');
  const batch: Array<Record<string, unknown>> = [{
    id: session.sessionId,
    type: 'trace-create',
    timestamp: session.startedAt,
    body: {
      id: session.sessionId,
      name: session.sessionName,
      timestamp: session.startedAt,
      metadata: {
        agentType: session.agentType,
        visreplaySchema: session.$schema
      },
      ...(firstInput === undefined ? {} : { input: firstInput.content }),
      ...(lastOutput === undefined ? {} : { output: lastOutput.content })
    }
  }];

  const unpairedResultIndexes = new Set(pairs.unpairedResults.map((event) => event.index));

  for (const event of session.events) {
    if (event.type === 'tool_result' && !unpairedResultIndexes.has(event.index)) {
      continue;
    }
    batch.push(langfuseItem(session.sessionId, event, pairs.resultByCallIndex.get(event.index)));
  }

  return { batch };
}

function langfuseItem(
  traceId: string,
  event: SessionEvent,
  pairedResult: SessionEvent | undefined
): Record<string, unknown> {
  const decision = decisionOf(event);
  const decisionMeta = decision === undefined
    ? {}
    : { metadata: { visreplay: { decision } } };

  if (event.type === 'tool_call') {
    return {
      id: event.eventId,
      type: 'span-create',
      timestamp: event.timestamp,
      body: {
        id: event.eventId,
        traceId,
        parentObservationId: null,
        name: event.name ?? 'tool',
        startTime: event.timestamp,
        input: event.arguments,
        ...(pairedResult === undefined ? {} : {
          endTime: pairedResult.timestamp,
          output: pairedResult.result
        }),
        ...decisionMeta
      }
    };
  }

  if (event.type === 'tool_result') {
    return {
      id: event.eventId,
      type: 'event-create',
      timestamp: event.timestamp,
      body: {
        id: event.eventId,
        traceId,
        parentObservationId: null,
        name: 'tool_result',
        startTime: event.timestamp,
        input: event.result,
        ...decisionMeta
      }
    };
  }

  if (event.type === 'error') {
    return {
      id: event.eventId,
      type: 'event-create',
      timestamp: event.timestamp,
      body: {
        id: event.eventId,
        traceId,
        parentObservationId: null,
        name: event.method ?? 'error',
        startTime: event.timestamp,
        level: 'ERROR',
        statusMessage: event.error,
        ...decisionMeta
      }
    };
  }

  if (event.type === 'output') {
    return {
      id: event.eventId,
      type: 'event-create',
      timestamp: event.timestamp,
      body: {
        id: event.eventId,
        traceId,
        parentObservationId: null,
        name: event.method ?? 'output',
        startTime: event.timestamp,
        output: event.content,
        ...decisionMeta
      }
    };
  }

  const name = event.type === 'reasoning'
    ? (decision === undefined ? 'reasoning' : 'decision')
    : (event.method ?? event.type);

  return {
    id: event.eventId,
    type: 'event-create',
    timestamp: event.timestamp,
    body: {
      id: event.eventId,
      traceId,
      parentObservationId: null,
      name,
      startTime: event.timestamp,
      input: event.content,
      ...decisionMeta
    }
  };
}

function buildOtlp(session: SessionData, pairs: ToolPairs, warnings: string[]): unknown {
  const version = readPackageVersion();
  const traceId = hexDigest(session.sessionId, 16);
  const spans: Array<Record<string, unknown>> = [];

  for (const event of session.events) {
    const startNano = unixNano(event.timestamp);
    if (startNano === undefined) {
      warnings.push(`skipped event ${event.index}: timestamp is not parseable`);
      continue;
    }
    const pairedResult = pairs.resultByCallIndex.get(event.index);
    const endNano = event.type === 'tool_call' && pairedResult !== undefined
      ? unixNano(pairedResult.timestamp) ?? plusOneMs(startNano)
      : plusOneMs(startNano);
    const pairedCallIndex = pairs.callIndexByResultIndex.get(event.index);
    const pairedCall = pairedCallIndex === undefined ? undefined : session.events[pairedCallIndex];
    const decision = decisionOf(event);
    const attributes = otlpAttributes(event, decision, event.name ?? pairedCall?.name);

    const span: Record<string, unknown> = {
      traceId,
      spanId: hexDigest(event.eventId, 8),
      name: event.method ?? event.name ?? event.type,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      status: event.type === 'error'
        ? { code: 2, message: event.error ?? 'error' }
        : { code: 1 },
      attributes
    };
    if (event.type === 'tool_result' && pairedCall !== undefined) {
      span.parentSpanId = hexDigest(pairedCall.eventId, 8);
    }
    spans.push(span);
  }

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          stringAttr('service.name', 'visreplay'),
          stringAttr('service.version', version),
          stringAttr('visreplay.session.id', session.sessionId),
          stringAttr('visreplay.session.name', session.sessionName),
          stringAttr('visreplay.agent.type', session.agentType)
        ]
      },
      scopeSpans: [{
        scope: { name: '@latticeag/visreplay', version },
        spans
      }]
    }]
  };
}

function otlpAttributes(
  event: SessionEvent,
  decision: DecisionRecord | undefined,
  toolName: string | undefined
): Array<Record<string, unknown>> {
  const attributes: Array<Record<string, unknown>> = [
    stringAttr('visreplay.event.type', event.type),
    intAttr('visreplay.event.index', event.index),
    stringAttr('visreplay.event.id', event.eventId)
  ];
  if (decision !== undefined) {
    attributes.push(stringAttr('visreplay.decision', JSON.stringify(decision)));
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    attributes.push(stringAttr('gen_ai.operation.name', 'tool'));
    if (toolName !== undefined) {
      attributes.push(stringAttr('gen_ai.tool.name', toolName));
    }
  } else if (event.type === 'reasoning') {
    attributes.push(stringAttr('gen_ai.operation.name', 'reasoning'));
  }

  const payload = firstDefined(event.content, event.arguments, event.result);
  if (payload !== undefined) {
    attributes.push(stringAttr('visreplay.payload', JSON.stringify(payload)));
  }
  return attributes;
}

function buildLangsmith(session: SessionData, pairs: ToolPairs, _warnings: string[]): unknown {
  const firstInput = firstOfType(session.events, 'input');
  const lastOutput = lastOfType(session.events, 'output');
  const lastTimestamp = session.events.length > 0
    ? session.events[session.events.length - 1].timestamp
    : session.startedAt;
  const endTime = session.endedAt ?? lastTimestamp ?? session.startedAt;
  const unpairedResultIndexes = new Set(pairs.unpairedResults.map((event) => event.index));
  const runs: Array<Record<string, unknown>> = [{
    id: session.sessionId,
    name: session.sessionName,
    run_type: 'chain',
    start_time: session.startedAt,
    end_time: endTime,
    inputs: {
      agentType: session.agentType,
      firstInput: firstInput?.content
    },
    outputs: {
      lastOutput: lastOutput?.content
    },
    extra: { metadata: {} }
  }];

  for (const event of session.events) {
    if (event.type === 'tool_result' && !unpairedResultIndexes.has(event.index)) {
      continue;
    }
    runs.push(langsmithChild(session.sessionId, event, pairs.resultByCallIndex.get(event.index)));
  }

  return runs;
}

function langsmithChild(
  parentId: string,
  event: SessionEvent,
  pairedResult: SessionEvent | undefined
): Record<string, unknown> {
  const decision = decisionOf(event);
  const extra = {
    metadata: decision === undefined ? {} : { visreplay: decision }
  };

  if (event.type === 'tool_call') {
    return {
      id: event.eventId,
      name: event.name ?? 'tool',
      run_type: 'tool',
      start_time: event.timestamp,
      end_time: pairedResult?.timestamp ?? event.timestamp,
      inputs: event.arguments ?? {},
      ...(pairedResult === undefined ? {} : { outputs: pairedResult.result }),
      parent_run_id: parentId,
      extra
    };
  }

  if (event.type === 'tool_result') {
    return {
      id: event.eventId,
      name: 'tool_result',
      run_type: 'tool',
      start_time: event.timestamp,
      end_time: event.timestamp,
      inputs: {},
      outputs: event.result,
      parent_run_id: parentId,
      extra
    };
  }

  if (event.type === 'reasoning') {
    return {
      id: event.eventId,
      name: decision === undefined ? 'reasoning' : 'decision',
      run_type: 'llm',
      start_time: event.timestamp,
      end_time: event.timestamp,
      inputs: { content: event.content },
      parent_run_id: parentId,
      extra
    };
  }

  if (event.type === 'error') {
    return {
      id: event.eventId,
      name: event.method ?? 'error',
      run_type: 'chain',
      start_time: event.timestamp,
      end_time: event.timestamp,
      inputs: {},
      error: event.error,
      parent_run_id: parentId,
      extra
    };
  }

  return {
    id: event.eventId,
    name: event.method ?? event.type,
    run_type: 'chain',
    start_time: event.timestamp,
    end_time: event.timestamp,
    inputs: event.type === 'input' ? { content: event.content } : {},
    ...(event.type === 'output' ? { outputs: { content: event.content } } : {}),
    parent_run_id: parentId,
    extra
  };
}

function hexDigest(value: string, byteCount: number): string {
  return createHash('sha256').update(value, 'utf8').digest().subarray(0, byteCount).toString('hex');
}

function unixNano(timestamp: string): string | undefined {
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) {
    return undefined;
  }
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

function plusOneMs(startNano: string): string {
  return (BigInt(startNano) + 1_000_000n).toString();
}

function stringAttr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): Record<string, unknown> {
  return { key, value: { intValue: value } };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function readPackageVersion(): string {
  try {
    const pkg = require(join(__dirname, '..', 'package.json')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version;
    }
  } catch {
    // Missing package.json must not fail an export.
  }
  return '0.0.0-unknown';
}
