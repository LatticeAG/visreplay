import { Session, SessionLoadOptions } from './session';
import { cloneJsonSafe, isSessionData, SessionData, SessionEvent } from './types';

/** The relationship between one baseline event and one candidate event. */
export type SessionEventDifferenceKind = 'unchanged' | 'changed' | 'added' | 'removed';

/** A single field whose JSON-safe value differs between two recordings. */
export interface SessionFieldDifference {
  /** The persisted field name. */
  field: string;
  /** The value in the baseline recording, omitted when the field was absent. */
  baseline?: unknown;
  /** The value in the candidate recording, omitted when the field was absent. */
  candidate?: unknown;
}

/**
 * One aligned event comparison. Events are aligned by their contiguous session
 * index, which makes the result deterministic and cheap for large recordings.
 */
export interface SessionEventDifference {
  kind: SessionEventDifferenceKind;
  /** Index in the baseline recording, when an event exists there. */
  baselineIndex?: number;
  /** Index in the candidate recording, when an event exists there. */
  candidateIndex?: number;
  /** Defensive baseline event snapshot, when an event exists there. */
  baseline?: SessionEvent;
  /** Defensive candidate event snapshot, when an event exists there. */
  candidate?: SessionEvent;
  /** Field-level changes when `kind` is `changed`. */
  changes: SessionFieldDifference[];
}

/** Aggregate counts that make a comparison inexpensive to render or export. */
export interface SessionComparisonSummary {
  baselineEventCount: number;
  candidateEventCount: number;
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
  metadataChanges: number;
}

/**
 * A deterministic, index-aligned diff between two session recordings.
 * Generated IDs and timestamps are ignored by default because they differ for
 * independently recorded runs with otherwise equivalent behavior.
 */
export interface SessionComparison {
  /** Whether the selected semantic fields and event sequence are identical. */
  equal: boolean;
  summary: SessionComparisonSummary;
  /** Differences in session-level metadata, excluding the events array. */
  metadata: SessionFieldDifference[];
  /** Event comparisons in stable baseline/candidate order. */
  events: SessionEventDifference[];
}

/** Options controlling which persisted fields participate in a session diff. */
export interface SessionComparisonOptions {
  /** Include unchanged event entries in the returned `events` array. Defaults to true. */
  includeUnchanged?: boolean;
  /** Compare `startedAt`, `endedAt`, and event timestamps. Defaults to false. */
  compareTimestamps?: boolean;
  /** Compare generated session and event IDs. Defaults to false. */
  compareIdentifiers?: boolean;
}

/** File-load limits plus comparison options for `compareSessionFiles`. */
export interface SessionFileComparisonOptions extends SessionComparisonOptions {
  maxFileBytes?: number;
  maxEvents?: number;
}

/** @deprecated Use SessionComparisonOptions. */
export type SessionDiffOptions = SessionComparisonOptions;

/** @deprecated Use SessionComparison. */
export type SessionDiff = SessionComparison;

const SESSION_FIELDS = ['sessionName', 'agentType'] as const;
const TIMESTAMP_SESSION_FIELDS = ['startedAt', 'endedAt'] as const;
const EVENT_FIELDS = [
  'type',
  'content',
  'name',
  'arguments',
  'result',
  'error',
  'method',
  'metadata'
] as const;

/**
 * Compare two in-memory VisReplay recordings without mutating either one.
 *
 * Events are intentionally paired by their persisted index. This mirrors the
 * append-only session contract and remains linear in the number of events,
 * including very large recordings. A newly inserted event therefore appears
 * as a changed event at its position followed by any added/removed tail.
 */
export function compareSessions(
  baseline: SessionData,
  candidate: SessionData,
  options: SessionComparisonOptions = {}
): SessionComparison {
  assertSessionData(baseline, 'baseline');
  assertSessionData(candidate, 'candidate');

  const includeUnchanged = options.includeUnchanged ?? true;
  const metadata = compareFields(
    baseline,
    candidate,
    sessionFields(options)
  );
  const eventDifferences: SessionEventDifference[] = [];
  let unchanged = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;
  const eventCount = Math.max(baseline.events.length, candidate.events.length);

  for (let index = 0; index < eventCount; index += 1) {
    const baselineEvent = baseline.events[index];
    const candidateEvent = candidate.events[index];

    if (baselineEvent === undefined) {
      added += 1;
      eventDifferences.push({
        kind: 'added',
        candidateIndex: candidateEvent.index,
        candidate: cloneEvent(candidateEvent),
        changes: []
      });
      continue;
    }

    if (candidateEvent === undefined) {
      removed += 1;
      eventDifferences.push({
        kind: 'removed',
        baselineIndex: baselineEvent.index,
        baseline: cloneEvent(baselineEvent),
        changes: []
      });
      continue;
    }

    const changes = compareFields(baselineEvent, candidateEvent, eventFields(options));
    if (changes.length === 0) {
      unchanged += 1;
      if (includeUnchanged) {
        eventDifferences.push({
          kind: 'unchanged',
          baselineIndex: baselineEvent.index,
          candidateIndex: candidateEvent.index,
          baseline: cloneEvent(baselineEvent),
          candidate: cloneEvent(candidateEvent),
          changes: []
        });
      }
      continue;
    }

    changed += 1;
    eventDifferences.push({
      kind: 'changed',
      baselineIndex: baselineEvent.index,
      candidateIndex: candidateEvent.index,
      baseline: cloneEvent(baselineEvent),
      candidate: cloneEvent(candidateEvent),
      changes
    });
  }

  const summary: SessionComparisonSummary = {
    baselineEventCount: baseline.events.length,
    candidateEventCount: candidate.events.length,
    unchanged,
    changed,
    added,
    removed,
    metadataChanges: metadata.length
  };

  return {
    equal: metadata.length === 0 && changed === 0 && added === 0 && removed === 0,
    summary,
    metadata,
    events: eventDifferences
  };
}

/** A concise alias for consumers that prefer diff-oriented terminology. */
export const diffSessions = compareSessions;

/**
 * Load and compare two portable session files. Loading uses Session's normal
 * validation and default redaction safeguards before calculating the diff.
 */
export async function compareSessionFiles(
  baselineFilePath: string,
  candidateFilePath: string,
  options: SessionFileComparisonOptions = {}
): Promise<SessionComparison> {
  const loadOptions: SessionLoadOptions = {
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents })
  };
  const [baseline, candidate] = await Promise.all([
    Session.load(baselineFilePath, loadOptions),
    Session.load(candidateFilePath, loadOptions)
  ]);
  const { maxFileBytes: _maxFileBytes, maxEvents: _maxEvents, ...comparisonOptions } = options;

  return compareSessions(baseline, candidate, comparisonOptions);
}

/** A concise alias for consumers that prefer diff-oriented terminology. */
export const diffSessionFiles = compareSessionFiles;

function assertSessionData(value: unknown, label: string): asserts value is SessionData {
  if (!isSessionData(value)) {
    throw new TypeError(`The ${label} value must be a valid VisReplay session`);
  }
}

function sessionFields(options: SessionComparisonOptions): readonly string[] {
  const fields: string[] = [...SESSION_FIELDS];
  if (options.compareTimestamps === true) {
    fields.push(...TIMESTAMP_SESSION_FIELDS);
  }
  if (options.compareIdentifiers === true) {
    fields.push('sessionId');
  }
  return fields;
}

function eventFields(options: SessionComparisonOptions): readonly string[] {
  const fields: string[] = [...EVENT_FIELDS];
  if (options.compareTimestamps === true) {
    fields.push('timestamp');
  }
  if (options.compareIdentifiers === true) {
    fields.push('eventId');
  }
  return fields;
}

function compareFields(
  baseline: object,
  candidate: object,
  fields: readonly string[]
): SessionFieldDifference[] {
  const changes: SessionFieldDifference[] = [];

  for (const field of fields) {
    const baselineField = readField(baseline, field);
    const candidateField = readField(candidate, field);
    if (fieldsMatch(baselineField, candidateField)) {
      continue;
    }

    changes.push({
      field,
      ...(baselineField.present ? { baseline: cloneJsonSafe(baselineField.value) } : {}),
      ...(candidateField.present ? { candidate: cloneJsonSafe(candidateField.value) } : {})
    });
  }

  return changes;
}

interface PresentField {
  present: boolean;
  value: unknown;
}

function readField(value: object, field: string): PresentField {
  const record = value as Record<string, unknown>;
  return {
    present: Object.prototype.hasOwnProperty.call(record, field),
    value: record[field]
  };
}

function fieldsMatch(baseline: PresentField, candidate: PresentField): boolean {
  if (baseline.present !== candidate.present) {
    return false;
  }
  if (!baseline.present) {
    return true;
  }

  return stableJson(cloneJsonSafe(baseline.value)) === stableJson(cloneJsonSafe(candidate.value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function cloneEvent(event: SessionEvent): SessionEvent {
  return cloneJsonSafe(event);
}
