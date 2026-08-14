import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { writeTextAtomically } from './atomic-write';
import {
  cloneJsonSafe,
  compileRedactionConfig,
  CompiledRedactionConfig,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_PATTERNS,
  DEBUG_EXPORT_SCHEMA,
  DebugExport,
  EVENT_TYPES,
  EventType,
  isEventType,
  isIsoUtcTimestamp,
  isRecord,
  isDecisionVisreplay,
  NewSessionEvent,
  RedactionOptions,
  RedactionPattern,
  REDACTED_VALUE,
  redactText,
  SESSION_SCHEMA,
  SessionData,
  SessionEvent,
  shouldRedactKey,
  toJsonSafe
} from './types';

/** Default upper bound for a file read in one local session load. */
export const DEFAULT_MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

/** Default upper bound that prevents a malformed event list from exhausting memory. */
export const DEFAULT_MAX_SESSION_EVENTS = 500_000;

/**
 * Resource limits and optional redaction settings for `Session.load`.
 * Set a larger explicit limit when a known-good recording exceeds the safe
 * defaults; neither limit is applied while recording in memory.
 */
export interface SessionLoadOptions extends RedactionOptions {
  maxFileBytes?: number;
  maxEvents?: number;
}

/**
 * Owns a single VisReplay session document, including safe event snapshots,
 * validation, atomic persistence, and creation of the stable debug report.
 */
export class Session {
  private sessionData: SessionData;
  private readonly redaction: CompiledRedactionConfig;

  public constructor(
    sessionName: string = 'unnamed-session',
    agentType: string = 'unknown',
    sessionId: string = createIdentifier('ses'),
    redactKeys?: readonly string[],
    redactPatterns?: readonly RedactionPattern[]
  ) {
    assertNonEmptyString(sessionName, 'session name');
    assertNonEmptyString(agentType, 'agent type');
    assertNonEmptyString(sessionId, 'session ID');
    this.redaction = compileRedactionConfig(
      redactKeys ?? DEFAULT_REDACT_KEYS,
      redactPatterns ?? (redactKeys === undefined ? DEFAULT_REDACT_PATTERNS : [])
    );

    this.sessionData = {
      $schema: SESSION_SCHEMA,
      sessionId: redactEnvelopeText('sessionId', sessionId, this.redaction),
      sessionName: redactEnvelopeText('sessionName', sessionName, this.redaction),
      agentType: redactEnvelopeText('agentType', agentType, this.redaction),
      startedAt: new Date().toISOString(),
      events: []
    };
  }

  /**
   * Compatibility-friendly read-only view. Every access returns a defensive
   * copy, so mutating it never changes the recorded session.
   */
  public get data(): SessionData {
    return this.getData();
  }

  /** Adds one validated event and returns its immutable snapshot. */
  public addEvent(event: NewSessionEvent): SessionEvent {
    const normalized = normalizeNewEvent(event, this.redaction);
    const storedEvent: SessionEvent = {
      ...normalized,
      eventId: createIdentifier('evt'),
      index: this.sessionData.events.length,
      timestamp: new Date().toISOString()
    };

    this.sessionData.events.push(storedEvent);
    return cloneEvent(storedEvent);
  }

  /** Returns a defensive snapshot of every recorded event. */
  public getEvents(): SessionEvent[] {
    return this.sessionData.events.map(event => cloneEvent(event));
  }

  /** Returns a defensive snapshot of the complete session document. */
  public getData(): SessionData {
    return cloneSessionData(this.sessionData);
  }

  /**
   * Marks the logical end of a run once. Later events may still be appended;
   * `endedAt` stays the first end time. `save()` does not call this.
   */
  public end(): SessionData {
    if (this.sessionData.endedAt === undefined) {
      this.sessionData.endedAt = new Date().toISOString();
    }
    return this.getData();
  }

  /**
   * Saves the current session as one portable UTF-8 JSON document. The target
   * is replaced atomically only after the temporary file has been written.
   */
  public async save(filePath: string): Promise<void> {
    assertFilePath(filePath);
    // JSON.stringify is synchronous and does not mutate its input, so this
    // preserves a point-in-time snapshot without first duplicating a very
    // large in-memory recording.
    try {
      await writeTextAtomically(filePath, `${JSON.stringify(this.sessionData, null, 2)}\n`);
    } catch (error) {
      throw new Error(`Unable to save session to "${filePath}": ${errorMessage(error)}`);
    }
  }

  /** Creates a stable summary and timeline without mutating the session. */
  public exportDebug(): DebugExport {
    const session = this.getData();
    const eventCounts = createEventCounts();
    let errorCount = 0;
    let firstError: DebugExport['summary']['firstError'];

    const timeline = session.events.map(event => {
      eventCounts[event.type] += 1;
      if (event.type === 'error') {
        errorCount += 1;
        if (!firstError) {
          firstError = {
            index: event.index,
            message: event.error ?? createPreview(event)
          };
        }
      }

      return {
        index: event.index,
        timestamp: event.timestamp,
        type: event.type,
        ...(event.method === undefined ? {} : { method: event.method }),
        ...(event.name === undefined ? {} : { name: event.name }),
        preview: createPreview(event)
      };
    });

    const decisions = session.events.flatMap((event) => {
      const visreplay = event.metadata === undefined ? undefined : event.metadata.visreplay;
      if (event.type !== 'reasoning' || !isDecisionVisreplay(visreplay)) {
        return [];
      }
      return [{
        index: event.index,
        timestamp: event.timestamp,
        preview: createPreview(event),
        decision: visreplay
      }];
    });

    const debugExport: DebugExport = {
      $schema: DEBUG_EXPORT_SCHEMA,
      session: {
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        agentType: session.agentType,
        startedAt: session.startedAt,
        ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt })
      },
      summary: {
        eventCount: session.events.length,
        eventCounts,
        errorCount,
        decisionCount: decisions.length,
        ...(firstError === undefined ? {} : { firstError })
      },
      timeline,
      events: session.events,
      decisions
    };

    return cloneJsonSafe(debugExport);
  }

  /** Builds a Session instance from a previously validated document. */
  public static fromData(
    data: SessionData,
    redactKeys?: readonly string[],
    redactPatterns?: readonly RedactionPattern[]
  ): Session {
    const resolvedKeys = redactKeys ?? DEFAULT_REDACT_KEYS;
    const resolvedPatterns = redactPatterns ?? (redactKeys === undefined ? DEFAULT_REDACT_PATTERNS : []);
    const redaction = compileRedactionConfig(resolvedKeys, resolvedPatterns);
    const normalized = validateSessionData(data, redaction);
    const session = new Session(
      normalized.sessionName,
      normalized.agentType,
      normalized.sessionId,
      resolvedKeys,
      resolvedPatterns
    );
    session.sessionData = normalized;
    return session;
  }

  /** Loads, parses, and validates a saved VisReplay session file. */
  public static load(filePath: string, options?: SessionLoadOptions): Promise<SessionData>;
  public static load(
    filePath: string,
    redactKeys?: readonly string[],
    redactPatterns?: readonly RedactionPattern[],
    options?: SessionLoadOptions
  ): Promise<SessionData>;
  public static async load(
    filePath: string,
    redactKeysOrOptions?: readonly string[] | SessionLoadOptions,
    passedPatterns?: readonly RedactionPattern[],
    passedOptions: SessionLoadOptions = {}
  ): Promise<SessionData> {
    assertFilePath(filePath);

    const options = resolveLoadOptions(redactKeysOrOptions, passedPatterns, passedOptions);

    let bytes: Buffer;
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error('path is not a regular file');
      }
      if (stats.size === 0) {
        throw new Error('file is empty');
      }
      if (stats.size > options.maxFileBytes) {
        throw new Error(`file size ${stats.size} bytes exceeds the ${options.maxFileBytes}-byte limit`);
      }
      bytes = await fs.readFile(filePath);
    } catch (error) {
      throw new Error(`Unable to read session file "${filePath}": ${errorMessage(error)}`);
    }

    if (bytes.byteLength === 0) {
      throw new Error(`Invalid VisReplay session in "${filePath}": file is empty`);
    }
    if (bytes.byteLength > options.maxFileBytes) {
      throw new Error(
        `Invalid VisReplay session in "${filePath}": file size ${bytes.byteLength} bytes exceeds the ${options.maxFileBytes}-byte limit`
      );
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`Invalid UTF-8 in session file "${filePath}": ${errorMessage(error)}`);
    }
    if (text.trim().length === 0) {
      throw new Error(`Invalid VisReplay session in "${filePath}": file is empty or whitespace only`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in session file "${filePath}": ${errorMessage(error)}`);
    }

    try {
      return validateSessionData(parsed, options.redaction, options.maxEvents);
    } catch (error) {
      throw new Error(`Invalid VisReplay session in "${filePath}": ${errorMessage(error)}`);
    }
  }
}

interface ResolvedSessionLoadOptions {
  readonly redaction: CompiledRedactionConfig;
  readonly maxFileBytes: number;
  readonly maxEvents: number;
}

function resolveLoadOptions(
  redactKeysOrOptions: readonly string[] | SessionLoadOptions | undefined,
  passedPatterns: readonly RedactionPattern[] | undefined,
  passedOptions: SessionLoadOptions
): ResolvedSessionLoadOptions {
  if (redactKeysOrOptions === undefined) {
    return {
      redaction: compileRedactionConfig(
        DEFAULT_REDACT_KEYS,
        passedPatterns ?? DEFAULT_REDACT_PATTERNS
      ),
      maxFileBytes: readLimit(passedOptions.maxFileBytes, DEFAULT_MAX_SESSION_FILE_BYTES, 'maxFileBytes'),
      maxEvents: readLimit(passedOptions.maxEvents, DEFAULT_MAX_SESSION_EVENTS, 'maxEvents')
    };
  }

  if (Array.isArray(redactKeysOrOptions)) {
    return {
      redaction: compileRedactionConfig(redactKeysOrOptions, passedPatterns ?? []),
      maxFileBytes: readLimit(passedOptions.maxFileBytes, DEFAULT_MAX_SESSION_FILE_BYTES, 'maxFileBytes'),
      maxEvents: readLimit(passedOptions.maxEvents, DEFAULT_MAX_SESSION_EVENTS, 'maxEvents')
    };
  }

  if (!isRecord(redactKeysOrOptions)) {
    throw new TypeError('Session load options must be an object or an array of redaction keys');
  }

  const hasConfiguredKeys = redactKeysOrOptions.redactKeys !== undefined;
  const configuredKeys = hasConfiguredKeys
    ? redactKeysOrOptions.redactKeys
    : DEFAULT_REDACT_KEYS;
  const configuredPatterns = redactKeysOrOptions.redactPatterns === undefined
    ? (hasConfiguredKeys ? [] : DEFAULT_REDACT_PATTERNS)
    : redactKeysOrOptions.redactPatterns;

  return {
    redaction: compileRedactionConfig(
      configuredKeys as readonly string[],
      configuredPatterns as readonly RedactionPattern[]
    ),
    maxFileBytes: readLimit(redactKeysOrOptions.maxFileBytes, DEFAULT_MAX_SESSION_FILE_BYTES, 'maxFileBytes'),
    maxEvents: readLimit(redactKeysOrOptions.maxEvents, DEFAULT_MAX_SESSION_EVENTS, 'maxEvents')
  };
}

function readLimit(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeNewEvent(
  event: NewSessionEvent,
  redaction: CompiledRedactionConfig
): Omit<SessionEvent, 'eventId' | 'index' | 'timestamp'> {
  if (!isRecord(event)) {
    throw new Error('Event must be an object');
  }

  if ('eventId' in event || 'index' in event || 'timestamp' in event) {
    throw new Error('Event ID, index, and timestamp are assigned by Session');
  }

  if (!isEventType(event.type)) {
    throw new Error(`Unknown event type: ${String(event.type)}`);
  }

  validateEventPayload(event, `event type "${event.type}"`);

  const normalized: Omit<SessionEvent, 'eventId' | 'index' | 'timestamp'> = {
    type: event.type
  };

  if (hasOwn(event, 'content')) {
    normalized.content = normalizeEnvelopeValue('content', event.content, redaction);
  }
  if (hasOwn(event, 'name')) {
    normalized.name = redactEnvelopeText('name', event.name as string, redaction);
  }
  if (hasOwn(event, 'arguments')) {
    normalized.arguments = normalizeEnvelopeRecord('arguments', event.arguments, redaction);
  }
  if (hasOwn(event, 'result')) {
    normalized.result = normalizeEnvelopeValue('result', event.result, redaction);
  }
  if (hasOwn(event, 'error')) {
    normalized.error = redactEnvelopeText('error', event.error as string, redaction);
  }
  if (hasOwn(event, 'method')) {
    normalized.method = redactEnvelopeText('method', event.method as string, redaction);
  }
  if (hasOwn(event, 'metadata')) {
    normalized.metadata = normalizeEnvelopeRecord('metadata', event.metadata, redaction);
  }

  return normalized;
}

function validateSessionData(
  value: unknown,
  redaction: CompiledRedactionConfig,
  maxEvents: number = Number.POSITIVE_INFINITY
): SessionData {
  if (!isRecord(value)) {
    throw new Error('expected a JSON object');
  }
  if (value.$schema !== SESSION_SCHEMA) {
    throw new Error(`expected $schema to be "${SESSION_SCHEMA}"`);
  }

  assertNonEmptyString(value.sessionId, 'sessionId');
  assertNonEmptyString(value.sessionName, 'sessionName');
  assertNonEmptyString(value.agentType, 'agentType');
  assertTimestamp(value.startedAt, 'startedAt');

  if (value.endedAt !== undefined) {
    assertTimestamp(value.endedAt, 'endedAt');
  }
  if (!Array.isArray(value.events)) {
    throw new Error('events must be an array');
  }
  if (value.events.length > maxEvents) {
    throw new Error(`events array has ${value.events.length} entries, exceeding the ${maxEvents}-event limit`);
  }

  const events: SessionEvent[] = [];
  for (let index = 0; index < value.events.length; index += 1) {
    events.push(validateStoredEvent(value.events[index], index, redaction));
  }
  const normalized: SessionData = {
    $schema: SESSION_SCHEMA,
    sessionId: redactEnvelopeText('sessionId', value.sessionId, redaction),
    sessionName: redactEnvelopeText('sessionName', value.sessionName, redaction),
    agentType: redactEnvelopeText('agentType', value.agentType, redaction),
    startedAt: value.startedAt,
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
    events
  };

  // Every mutable payload is normalized into a new JSON-safe value above;
  // returning this fresh document avoids a second full deep clone for large
  // recordings while retaining isolation from the caller's source object.
  return normalized;
}

function validateStoredEvent(
  value: unknown,
  position: number,
  redaction: CompiledRedactionConfig
): SessionEvent {
  if (!isRecord(value)) {
    throw new Error(`event at position ${position} must be an object`);
  }
  if (!isNonEmptyString(value.eventId)) {
    throw new Error(`event at position ${position} has an invalid eventId`);
  }
  if (!Number.isInteger(value.index) || value.index !== position) {
    throw new Error(`event at position ${position} must have contiguous index ${position}`);
  }
  assertTimestamp(value.timestamp, `event at position ${position} timestamp`);
  if (!isEventType(value.type)) {
    throw new Error(`event at position ${position} has unknown type "${String(value.type)}"`);
  }

  validateEventPayload(value, `event at position ${position}`);

  const event: SessionEvent = {
    eventId: redactEnvelopeText('eventId', value.eventId, redaction),
    index: value.index,
    timestamp: value.timestamp,
    type: value.type
  };

  if (hasOwn(value, 'content')) event.content = normalizeEnvelopeValue('content', value.content, redaction);
  if (hasOwn(value, 'name')) event.name = redactEnvelopeText('name', value.name as string, redaction);
  if (hasOwn(value, 'arguments')) event.arguments = normalizeEnvelopeRecord('arguments', value.arguments, redaction);
  if (hasOwn(value, 'result')) event.result = normalizeEnvelopeValue('result', value.result, redaction);
  if (hasOwn(value, 'error')) event.error = redactEnvelopeText('error', value.error as string, redaction);
  if (hasOwn(value, 'method')) event.method = redactEnvelopeText('method', value.method as string, redaction);
  if (hasOwn(value, 'metadata')) event.metadata = normalizeEnvelopeRecord('metadata', value.metadata, redaction);

  return event;
}

/** Normalize an arbitrary envelope value while honouring a matching field name. */
function normalizeEnvelopeValue(
  fieldName: string,
  value: unknown,
  redaction: CompiledRedactionConfig
): unknown {
  if (shouldRedactKey(fieldName, redaction)) {
    return REDACTED_VALUE;
  }
  return toJsonSafe(value, redaction);
}

/**
 * The persisted schema requires arguments and metadata to remain objects.
 * When an envelope key itself is redacted (or a hostile object cannot be
 * walked), retain that invariant with an explicitly marked object.
 */
function normalizeEnvelopeRecord(
  fieldName: string,
  value: unknown,
  redaction: CompiledRedactionConfig
): Record<string, unknown> {
  if (shouldRedactKey(fieldName, redaction)) {
    return { value: REDACTED_VALUE };
  }

  const normalized = toJsonSafe(value, redaction);
  return isRecord(normalized) ? normalized : { value: normalized };
}

/** Redact a scalar field by its field name and any matching text pattern. */
function redactEnvelopeText(
  fieldName: string,
  value: string,
  redaction: CompiledRedactionConfig
): string {
  return shouldRedactKey(fieldName, redaction)
    ? REDACTED_VALUE
    : redactText(value, redaction);
}

function validateEventPayload(event: Record<string, unknown>, context: string): void {
  if ((event.name !== undefined && typeof event.name !== 'string')
    || (event.method !== undefined && typeof event.method !== 'string')
    || (event.error !== undefined && typeof event.error !== 'string')
    || (event.arguments !== undefined && !isRecord(event.arguments))
    || (event.metadata !== undefined && !isRecord(event.metadata))) {
    throw new Error(`${context} has invalid optional fields`);
  }

  switch (event.type) {
    case 'input':
    case 'reasoning':
    case 'output':
      if (!hasOwn(event, 'content')) {
        throw new Error(`${context} requires content`);
      }
      break;
    case 'tool_call':
      if (!isNonEmptyString(event.name) || !hasOwn(event, 'arguments') || !isRecord(event.arguments)) {
        throw new Error(`${context} requires a non-empty name and arguments object`);
      }
      break;
    case 'tool_result':
      if (!hasOwn(event, 'result')) {
        throw new Error(`${context} requires result`);
      }
      break;
    case 'error':
      if (!isNonEmptyString(event.error)) {
        throw new Error(`${context} requires a non-empty error message`);
      }
      break;
    default:
      throw new Error(`${context} has an unknown event type`);
  }
}

function cloneSessionData(data: SessionData): SessionData {
  return cloneJsonSafe(data);
}

function cloneEvent(event: SessionEvent): SessionEvent {
  return cloneJsonSafe(event);
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function createEventCounts(): Record<EventType, number> {
  return Object.fromEntries(EVENT_TYPES.map(type => [type, 0])) as Record<EventType, number>;
}

function createPreview(event: SessionEvent): string {
  if (event.error !== undefined) return truncate(event.error);
  if (event.content !== undefined) return truncate(stringifyPreviewValue(event.content));
  if (event.type === 'tool_call') {
    const name = event.name ?? 'tool';
    return truncate(`${name}(${stringifyPreviewValue(event.arguments ?? {})})`);
  }
  if (event.result !== undefined) return truncate(stringifyPreviewValue(event.result));
  if (event.name !== undefined) return truncate(event.name);
  return event.type;
}

function stringifyPreviewValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(toJsonSafe(value));
  } catch {
    return '[Unserializable]';
  }
}

function truncate(value: string, limit: number = 160): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function assertFilePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('A non-empty session file path is required');
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (!isIsoUtcTimestamp(value)) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
