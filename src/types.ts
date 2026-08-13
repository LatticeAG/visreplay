/**
 * Shared, runtime-independent definitions for the LatticeAG VisReplay SDK.
 * This module deliberately has no Node imports so its pure transformations can
 * be reused by a future browser or Worker adapter.
 */

export const SESSION_SCHEMA = 'visreplay/session/1.0' as const;
export const DEBUG_EXPORT_SCHEMA = 'visreplay/debug/1.0' as const;

export const EVENT_TYPES = [
  'input',
  'reasoning',
  'tool_call',
  'tool_result',
  'output',
  'error'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/** The stable event representation persisted in a VisReplay v1 session. */
export interface SessionEvent {
  eventId: string;
  index: number;
  timestamp: string;
  type: EventType;
  content?: unknown;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  method?: string;
  metadata?: Record<string, unknown>;
}

/** An event supplied by an SDK caller before Session assigns its envelope. */
export type NewSessionEvent = Omit<SessionEvent, 'eventId' | 'index' | 'timestamp'>;

/** The portable JSON document written by Session.save. */
export interface SessionData {
  $schema: typeof SESSION_SCHEMA;
  sessionId: string;
  sessionName: string;
  agentType: string;
  startedAt: string;
  endedAt?: string;
  events: SessionEvent[];
}

/**
 * A regular expression used to remove sensitive material. String entries are
 * interpreted as regular-expression source, which makes the configuration
 * convenient to load from JSON as well as to provide directly in code.
 */
export type RedactionPattern = RegExp | string | RedactionPatternDefinition;

/** A JSON-friendly regular-expression definition for redaction settings. */
export interface RedactionPatternDefinition {
  pattern: string;
  flags?: string;
}

/** Shared redaction configuration accepted by recording and loading APIs. */
export interface RedactionOptions {
  /**
   * Keys whose values are replaced recursively before they can be inspected
   * or persisted. An explicit empty array disables the default key set.
   */
  redactKeys?: readonly string[];
  /**
   * Expressions matched against property names and textual values. A matching
   * property name replaces its whole value; matching text is replaced in situ.
   * An explicit empty array disables the default pattern set.
   */
  redactPatterns?: readonly RedactionPattern[];
}

/**
 * A precompiled redaction configuration. Reusing one avoids recompiling
 * patterns for every event in a large session.
 */
export interface CompiledRedactionConfig {
  readonly keys: ReadonlySet<string>;
  readonly patterns: readonly RegExp[];
}

export interface VisReplayOptions extends RedactionOptions {
  sessionId?: string;
  sessionName?: string;
  agentType?: string;
}

/** @deprecated Use VisReplayOptions. */
export type LexReplayOptions = VisReplayOptions;

export interface DebugTimelineEvent {
  index: number;
  timestamp: string;
  type: EventType;
  method?: string;
  name?: string;
  preview: string;
}

export interface DebugExport {
  $schema: typeof DEBUG_EXPORT_SCHEMA;
  session: Pick<SessionData, 'sessionId' | 'sessionName' | 'agentType' | 'startedAt' | 'endedAt'>;
  summary: {
    eventCount: number;
    eventCounts: Record<EventType, number>;
    errorCount: number;
    firstError?: {
      index: number;
      message: string;
    };
  };
  timeline: DebugTimelineEvent[];
  events: SessionEvent[];
}

/** Default secret-like keys used by VisReplay unless callers override them. */
export const DEFAULT_REDACT_KEYS = [
  'apiKey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'token'
] as const;

/**
 * Secret-shaped values that are commonly embedded directly in prompt or
 * WebSocket text rather than stored below a secret-shaped property name.
 * Callers can replace this list by passing an explicit `redactPatterns` array.
 */
export const DEFAULT_REDACT_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
]);

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const REDACTED_VALUE = '[REDACTED]' as const;

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) {
    return false;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return false;
  }

  const canonicalValue = value.includes('.') ? value : value.replace('Z', '.000Z');
  return timestamp.toISOString() === canonicalValue;
}

/**
 * Converts arbitrary JavaScript values into JSON-safe snapshots. The result is
 * deterministic, avoids executing user toJSON methods, and visibly records
 * values JSON cannot represent directly.
 */
export function toJsonSafe(
  value: unknown,
  redactKeys?: readonly string[],
  redactPatterns?: readonly RedactionPattern[]
): JsonValue;
export function toJsonSafe(value: unknown, redaction?: CompiledRedactionConfig): JsonValue;
export function toJsonSafe(
  value: unknown,
  redactKeysOrConfig: readonly string[] | CompiledRedactionConfig = [],
  redactPatterns: readonly RedactionPattern[] = []
): JsonValue {
  const redaction = isCompiledRedactionConfig(redactKeysOrConfig)
    ? redactKeysOrConfig
    : compileRedactionConfig(redactKeysOrConfig, redactPatterns);
  return normalizeJsonValue(value, redaction, new WeakSet<object>(), 0);
}

/** Returns a fresh, JSON-safe deep copy of a value. */
export function cloneJsonSafe<T>(value: T): T {
  return toJsonSafe(value) as T;
}

/**
 * Compiles redaction configuration once for reuse across a recording or a
 * large session load. Invalid patterns fail early with an actionable error.
 */
export function compileRedactionConfig(
  redactKeys: readonly string[] = [],
  redactPatterns: readonly RedactionPattern[] = []
): CompiledRedactionConfig {
  if (!Array.isArray(redactKeys) || !redactKeys.every(key => typeof key === 'string')) {
    throw new TypeError('Redaction keys must be an array of strings');
  }

  return {
    keys: new Set(redactKeys.map(key => key.toLowerCase())),
    patterns: compileRedactionPatterns(redactPatterns)
  };
}

/**
 * Converts each supported pattern form into a global regular expression. A
 * clone is returned so caller-owned RegExp `lastIndex` state cannot affect
 * redaction results.
 */
export function compileRedactionPatterns(
  patterns: readonly RedactionPattern[] = []
): RegExp[] {
  if (!Array.isArray(patterns)) {
    throw new TypeError('Redaction patterns must be an array');
  }

  return patterns.map((pattern, index) => {
    let source: string;
    let flags: string;

    if (pattern instanceof RegExp) {
      source = pattern.source;
      flags = pattern.flags;
    } else if (typeof pattern === 'string') {
      source = pattern;
      flags = '';
    } else if (isRedactionPatternDefinition(pattern)) {
      source = pattern.pattern;
      flags = pattern.flags ?? '';
    } else {
      throw new TypeError(`Invalid redaction pattern at index ${index}`);
    }

    // Sticky expressions only match at their current cursor. Redaction needs
    // to inspect the whole string, so normalize every pattern to global mode.
    const globalFlags = flags.replace(/y/g, '').includes('g')
      ? flags.replace(/y/g, '')
      : `${flags.replace(/y/g, '')}g`;
    try {
      return new RegExp(source, globalFlags);
    } catch (error) {
      throw new TypeError(`Invalid redaction pattern at index ${index}: ${errorMessage(error)}`);
    }
  });
}

/** Returns whether a key should have its complete value replaced. */
export function shouldRedactKey(key: string, redaction: CompiledRedactionConfig): boolean {
  if (redaction.keys.has(key.toLowerCase())) {
    return true;
  }

  return redaction.patterns.some(pattern => testPattern(pattern, key));
}

/** Redacts every matching substring in a textual value. */
export function redactText(
  value: string,
  patternsOrConfig: readonly RedactionPattern[] | CompiledRedactionConfig = []
): string {
  const patterns = isCompiledRedactionConfig(patternsOrConfig)
    ? patternsOrConfig.patterns
    : compileRedactionPatterns(patternsOrConfig);
  return redactTextWithPatterns(value, patterns);
}

/** Runtime guard for a complete persisted event. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)
    || typeof value.eventId !== 'string' || value.eventId.length === 0
    || typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0
    || !isIsoUtcTimestamp(value.timestamp)
    || !isEventType(value.type)) {
    return false;
  }

  return hasValidOptionalFields(value) && hasRequiredEventPayload(value);
}

/** Runtime guard for a complete persisted session document. */
export function isSessionData(value: unknown): value is SessionData {
  if (!isRecord(value)
    || value.$schema !== SESSION_SCHEMA
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.sessionName)
    || !isNonEmptyString(value.agentType)
    || !isIsoUtcTimestamp(value.startedAt)
    || (value.endedAt !== undefined && !isIsoUtcTimestamp(value.endedAt))
    || !Array.isArray(value.events)) {
    return false;
  }

  return value.events.every((event, index) => isSessionEvent(event) && event.index === index);
}

function normalizeJsonValue(
  value: unknown,
  redaction: CompiledRedactionConfig,
  ancestors: WeakSet<object>,
  depth: number
): JsonValue {
  if (depth > 50) {
    return '[MaxDepth]';
  }

  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return redactTextWithPatterns(value, redaction.patterns);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : `[Number: ${String(value)}]`;
  }

  if (typeof value === 'undefined') {
    return '[undefined]';
  }

  if (typeof value === 'bigint') {
    return `[BigInt: ${value.toString()}]`;
  }

  if (typeof value === 'function') {
    return `[Function: ${value.name || 'anonymous'}]`;
  }

  if (typeof value === 'symbol') {
    return `[Symbol: ${value.description ?? ''}]`;
  }

  if (ancestors.has(value)) {
    return '[Circular]';
  }

  ancestors.add(value);
  try {
    if (value instanceof Date) {
      const timestamp = value.toISOString();
      return timestamp;
    }

    if (value instanceof Error) {
      return normalizeError(value, redaction, ancestors, depth);
    }

    if (value instanceof RegExp) {
      return `[RegExp: ${value.toString()}]`;
    }

    if (value instanceof Map) {
      return Array.from(value.entries(), ([key, mapValue]) => [
        normalizeJsonValue(key, redaction, ancestors, depth + 1),
        normalizeJsonValue(mapValue, redaction, ancestors, depth + 1)
      ]);
    }

    if (value instanceof Set) {
      return Array.from(value, item => normalizeJsonValue(item, redaction, ancestors, depth + 1));
    }

    if (Array.isArray(value)) {
      return value.map(item => normalizeJsonValue(item, redaction, ancestors, depth + 1));
    }

    return normalizeObject(value, redaction, ancestors, depth);
  } catch (error) {
    return `[Unserializable: ${errorMessage(error)}]`;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeError(
  error: Error,
  redaction: CompiledRedactionConfig,
  ancestors: WeakSet<object>,
  depth: number
): JsonObject {
  const normalized: JsonObject = {
    name: shouldRedactKey('name', redaction)
      ? REDACTED_VALUE
      : redactTextWithPatterns(error.name || 'Error', redaction.patterns),
    message: shouldRedactKey('message', redaction)
      ? REDACTED_VALUE
      : redactTextWithPatterns(error.message, redaction.patterns)
  };

  if (error.stack) {
    normalized.stack = shouldRedactKey('stack', redaction)
      ? REDACTED_VALUE
      : redactTextWithPatterns(error.stack, redaction.patterns);
  }

  for (const key of Object.keys(error).sort()) {
    if (key in normalized) {
      continue;
    }
    normalized[key] = shouldRedactKey(key, redaction)
      ? REDACTED_VALUE
      : normalizeProperty(error, key, redaction, ancestors, depth + 1);
  }

  return normalized;
}

function normalizeObject(
  value: object,
  redaction: CompiledRedactionConfig,
  ancestors: WeakSet<object>,
  depth: number
): JsonObject {
  const normalized: JsonObject = {};

  for (const key of Object.keys(value).sort()) {
    normalized[key] = shouldRedactKey(key, redaction)
      ? REDACTED_VALUE
      : normalizeProperty(value, key, redaction, ancestors, depth + 1);
  }

  return normalized;
}

function normalizeProperty(
  value: object,
  key: string,
  redaction: CompiledRedactionConfig,
  ancestors: WeakSet<object>,
  depth: number
): JsonValue {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) {
      return '[Accessor]';
    }
    return normalizeJsonValue(descriptor?.value, redaction, ancestors, depth);
  } catch (error) {
    return `[Unserializable: ${errorMessage(error)}]`;
  }
}

function isCompiledRedactionConfig(value: unknown): value is CompiledRedactionConfig {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CompiledRedactionConfig>;
  return candidate.keys instanceof Set
    && Array.isArray(candidate.patterns)
    && candidate.patterns.every(pattern => pattern instanceof RegExp);
}

function isRedactionPatternDefinition(value: unknown): value is RedactionPatternDefinition {
  return isRecord(value)
    && typeof value.pattern === 'string'
    && (value.flags === undefined || typeof value.flags === 'string');
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  try {
    return pattern.test(value);
  } finally {
    pattern.lastIndex = 0;
  }
}

function redactTextWithPatterns(value: string, patterns: readonly RegExp[]): string {
  let redacted = value;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    try {
      redacted = redacted.replace(pattern, REDACTED_VALUE);
    } finally {
      pattern.lastIndex = 0;
    }
  }
  return redacted;
}

function hasValidOptionalFields(event: Record<string, unknown>): boolean {
  return (event.name === undefined || typeof event.name === 'string')
    && (event.method === undefined || typeof event.method === 'string')
    && (event.error === undefined || typeof event.error === 'string')
    && (event.arguments === undefined || isRecord(event.arguments))
    && (event.metadata === undefined || isRecord(event.metadata));
}

function hasRequiredEventPayload(event: Record<string, unknown>): boolean {
  switch (event.type) {
    case 'input':
    case 'reasoning':
    case 'output':
      return Object.prototype.hasOwnProperty.call(event, 'content');
    case 'tool_call':
      return isNonEmptyString(event.name)
        && Object.prototype.hasOwnProperty.call(event, 'arguments')
        && isRecord(event.arguments);
    case 'tool_result':
      return Object.prototype.hasOwnProperty.call(event, 'result');
    case 'error':
      return isNonEmptyString(event.error);
    default:
      return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
