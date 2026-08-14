import * as readline from 'node:readline';

import { compareSessions, SessionComparison, SessionComparisonOptions } from './diff';
import { Session } from './session';
import {
  cloneJsonSafe,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_PATTERNS,
  RedactionPattern,
  SessionData,
  SessionEvent
} from './types';

/** The action selected by an interactive replay pause. */
export type PlaybackDecision = 'continue' | 'quit';

/** A small output seam that keeps replay usable in terminals and tests. */
export type PlayerWriter = (line: string) => void;

export interface PlayOptions {
  /** Print events without waiting for terminal input. */
  auto?: boolean;
  /** Delay between automatically printed events, in milliseconds. */
  delayMs?: number;
  /** Override the interactive pause behaviour. */
  pause?: () => Promise<PlaybackDecision>;
  /** Override sleeping, primarily useful for embedding and testing. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Observe each event after it is rendered. */
  onEvent?: (event: SessionEvent) => void | Promise<void>;
}

export interface PlaybackResult {
  /** Number of events rendered during this call. */
  played: number;
  /** The final event cursor, or -1 for an empty or rewound session. */
  cursor: number;
  /** Whether playback reached the final event rather than being quit. */
  completed: boolean;
}

/** The current lifecycle state of a replay run. */
export type PlaybackState = 'idle' | 'playing' | 'paused' | 'completed' | 'stopped';

export interface PlayerOptions {
  /** Destination for human-readable replay output. */
  write?: PlayerWriter;
  /** Default automatic delay used when `play({ auto: true })` is called. */
  autoDelayMs?: number;
  /** Keys redacted while loading or restoring session data. */
  redactKeys?: readonly string[];
  /** Text and property-name patterns redacted while loading or restoring data. */
  redactPatterns?: readonly RedactionPattern[];
  /** Override the default 64 MiB session file size limit when loading. */
  maxFileBytes?: number;
  /** Override the default 500_000 event limit when loading. */
  maxEvents?: number;
}

const DEFAULT_AUTO_DELAY_MS = 0;

/**
 * Replays the already-recorded event log. It never invokes an agent or a tool.
 */
export class Player {
  private sessionData: SessionData | null = null;
  private eventCursor = -1;
  private stateValue: PlaybackState = 'idle';
  private playbackActive = false;
  private stopRequested = false;
  private readonly resumeWaiters = new Set<() => void>();
  private readonly write: PlayerWriter;
  private readonly autoDelayMs: number;
  private readonly redactKeys: readonly string[];
  private readonly redactPatterns: readonly RedactionPattern[];
  private readonly maxFileBytes?: number;
  private readonly maxEvents?: number;

  public constructor(options: PlayerOptions = {}) {
    this.write = options.write ?? ((line) => console.log(line));
    this.autoDelayMs = normaliseDelay(options.autoDelayMs ?? DEFAULT_AUTO_DELAY_MS);
    this.redactKeys = [...(options.redactKeys ?? DEFAULT_REDACT_KEYS)];
    // Supplying a key list has historically meant callers own the redaction
    // configuration. Keep implicit regex defaults only when neither setting
    // was supplied; callers can always pass patterns explicitly.
    const defaultPatterns = options.redactKeys === undefined ? DEFAULT_REDACT_PATTERNS : [];
    this.redactPatterns = [...(options.redactPatterns ?? defaultPatterns)];
    this.maxFileBytes = options.maxFileBytes;
    this.maxEvents = options.maxEvents;
  }

  /** Load a session file and reset the replay cursor before its first event. */
  public async load(filePath: string): Promise<SessionData> {
    this.assertSessionReplacementAllowed();
    const sessionData = await Session.load(filePath, {
      redactKeys: this.redactKeys,
      redactPatterns: this.redactPatterns,
      maxFileBytes: this.maxFileBytes,
      maxEvents: this.maxEvents
    });
    this.setSession(sessionData);
    this.write(`Loaded session: ${sessionData.sessionName} (${sessionData.events.length} events)`);
    return sessionData;
  }

  /** Set an in-memory session, which is useful for SDK consumers and tests. */
  public setSession(sessionData: SessionData): void {
    this.assertSessionReplacementAllowed();
    if (!sessionData || typeof sessionData !== 'object') {
      throw new TypeError('A valid VisReplay session is required');
    }

    try {
      // Session.fromData is the canonical validator and gives Player its own
      // defensive snapshot rather than retaining a mutable caller reference.
      this.sessionData = Session.fromData(sessionData, this.redactKeys, this.redactPatterns).getData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(`Invalid VisReplay session: ${message}`);
    }
    this.eventCursor = -1;
    this.stopRequested = false;
    this.stateValue = 'idle';
  }

  /** Return the currently loaded session, or throw when no session has been loaded. */
  public getSession(): SessionData {
    return cloneJsonSafe(this.requireSession());
  }

  /** Current event index. `-1` means the replay is positioned before the first event. */
  public get cursor(): number {
    return this.eventCursor;
  }

  /** Current replay lifecycle state. */
  public get state(): PlaybackState {
    return this.stateValue;
  }

  /** Alias for `state` when integrating with view-model style consumers. */
  public get playbackState(): PlaybackState {
    return this.stateValue;
  }

  /** Whether a call to `play` is currently running and waiting or rendering. */
  public get isPlaying(): boolean {
    return this.playbackActive && this.stateValue === 'playing';
  }

  /** Whether replay progression is held until `resume()` is called. */
  public get isPaused(): boolean {
    return this.stateValue === 'paused';
  }

  /** Alias for `isPaused`, useful in simple UI bindings. */
  public get paused(): boolean {
    return this.isPaused;
  }

  /** The event at the current cursor, if the cursor points at an event. */
  public get currentEvent(): SessionEvent | null {
    const session = this.requireSession();
    const event = session.events[this.eventCursor];
    return event === undefined ? null : cloneJsonSafe(event);
  }

  /** Move one event forward without printing it. */
  public stepNext(): SessionEvent | null {
    this.assertNavigationAllowed();
    const event = this.advanceCursor();
    if (event) {
      this.markManualCursorMove();
    }
    return event;
  }

  /** Move forward one event. Alias for `stepNext()` for step-through UIs. */
  public stepForward(): SessionEvent | null {
    return this.stepNext();
  }

  /** Move one event back without printing it. */
  public stepPrevious(): SessionEvent | null {
    this.assertNavigationAllowed();
    this.requireSession();
    if (this.eventCursor <= 0) {
      this.eventCursor = -1;
      this.markManualCursorMove();
      return null;
    }

    this.eventCursor -= 1;
    this.markManualCursorMove();
    return this.currentEvent;
  }

  /** Move backward one event. Alias for `stepPrevious()` for step-through UIs. */
  public stepBackward(): SessionEvent | null {
    return this.stepPrevious();
  }

  /** Jump directly to an event index. */
  public jumpTo(index: number): SessionEvent {
    this.assertNavigationAllowed();
    const session = this.requireSession();
    if (!Number.isInteger(index) || index < 0 || index >= session.events.length) {
      throw new RangeError(`Event index ${index} is outside the session bounds`);
    }

    this.eventCursor = index;
    this.markManualCursorMove();
    return cloneJsonSafe(session.events[index]);
  }

  /** Position the replay before the first event. */
  public rewind(): void {
    this.assertNavigationAllowed();
    this.requireSession();
    this.eventCursor = -1;
    this.markManualCursorMove();
  }

  /** Position the replay before its first event. Alias for `rewind()`. */
  public reset(): void {
    this.rewind();
  }

  /**
   * Hold replay progression. Calling this before `play()` starts leaves the
   * player paused until `resume()` is called; navigation remains available.
   */
  public pause(): void {
    this.requireSession();
    if (this.stateValue === 'completed' || this.stateValue === 'stopped') {
      return;
    }

    this.stateValue = 'paused';
  }

  /** Continue a paused replay and release any pending `play()` call. */
  public resume(): void {
    this.requireSession();
    if (this.stateValue !== 'paused') {
      return;
    }

    this.stateValue = this.playbackActive ? 'playing' : 'idle';
    this.releaseResumeWaiters();
  }

  /**
   * Stop the active replay without changing its cursor. A later `play()` call
   * can continue from that cursor. This is primarily useful for host UIs.
   */
  public stop(): void {
    this.requireSession();
    if (!this.playbackActive) {
      return;
    }

    this.stopRequested = true;
    this.stateValue = 'stopped';
    this.releaseResumeWaiters();
  }

  /** Compare this loaded recording against another loaded player or session. */
  public compareWith(
    candidate: Player | SessionData,
    options: SessionComparisonOptions = {}
  ): SessionComparison {
    const candidateSession = candidate instanceof Player ? candidate.getSession() : candidate;
    return compareSessions(this.requireSession(), candidateSession, options);
  }

  /**
   * Render events beginning after the current cursor. Pass `true` for the
   * backwards-compatible automatic mode, or supply options for more control.
   */
  public async play(autoOrOptions: boolean | PlayOptions = false): Promise<PlaybackResult> {
    const session = this.requireSession();
    if (this.playbackActive) {
      throw new Error('Playback is already in progress');
    }

    const options = toPlayOptions(autoOrOptions);
    const auto = options.auto ?? false;
    const delayMs = normaliseDelay(options.delayMs ?? this.autoDelayMs);
    const pause = options.pause ?? askToContinue;
    const sleep = options.sleep ?? wait;
    let played = 0;
    let stopped = false;

    this.playbackActive = true;
    this.stopRequested = false;
    if (this.stateValue !== 'paused') {
      this.stateValue = 'playing';
    }

    try {
      while (true) {
        if (this.eventCursor >= session.events.length - 1) {
          break;
        }

        await this.waitUntilResumed();
        if (this.stopRequested) {
          stopped = true;
          break;
        }

        const event = this.advanceCursor();
        if (!event) {
          break;
        }

        this.printEvent(event);
        played += 1;
        await options.onEvent?.(event);

        const hasMoreEvents = this.eventCursor < session.events.length - 1;
        if (!hasMoreEvents) {
          continue;
        }

        // A pause requested by an event observer should take effect before a
        // delay or an interactive terminal prompt is started.
        await this.waitUntilResumed();
        if (this.stopRequested) {
          stopped = true;
          break;
        }

        if (auto) {
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        } else if (await pause() === 'quit') {
          stopped = true;
          this.stateValue = 'stopped';
          break;
        }
      }

      const completed = !stopped && (session.events.length === 0 || this.eventCursor === session.events.length - 1);
      if (completed) {
        this.stateValue = 'completed';
        this.write('--- End of Session ---');
      } else if (stopped) {
        this.stateValue = 'stopped';
      }

      return { played, cursor: this.eventCursor, completed };
    } finally {
      this.playbackActive = false;
      if (this.stateValue === 'playing') {
        this.stateValue = 'idle';
      }
    }
  }

  /** Render one event in a stable, readable terminal format. */
  public printEvent(event: SessionEvent): void {
    for (const line of formatEvent(event)) {
      this.write(line);
    }
  }

  private advanceCursor(): SessionEvent | null {
    const session = this.requireSession();
    if (this.eventCursor >= session.events.length - 1) {
      return null;
    }

    this.eventCursor += 1;
    return cloneJsonSafe(session.events[this.eventCursor]);
  }

  private assertSessionReplacementAllowed(): void {
    if (this.playbackActive) {
      throw new Error('Cannot replace a session while playback is in progress');
    }
  }

  private assertNavigationAllowed(): void {
    if (this.playbackActive && this.stateValue === 'playing') {
      throw new Error('Pause playback before changing the replay cursor');
    }
  }

  private markManualCursorMove(): void {
    if (!this.playbackActive && (this.stateValue === 'completed' || this.stateValue === 'stopped')) {
      this.stateValue = 'idle';
    }
  }

  private requireSession(): SessionData {
    if (!this.sessionData) {
      throw new Error('No session loaded');
    }

    return this.sessionData;
  }

  private async waitUntilResumed(): Promise<void> {
    while (this.stateValue === 'paused' && !this.stopRequested) {
      await new Promise<void>((resolve) => {
        this.resumeWaiters.add(resolve);
      });
    }
  }

  private releaseResumeWaiters(): void {
    for (const resolve of this.resumeWaiters) {
      resolve();
    }
    this.resumeWaiters.clear();
  }
}

/** Format an event for replay without writing to a terminal. */
export function formatEvent(event: SessionEvent): string[] {
  const lines = [`[${event.timestamp}] EVENT: ${event.type.toUpperCase()} (Index: ${event.index})`];
  const payload = objectValue(event, 'payload');
  const eventId = eventValue(event, 'eventId');
  const content = firstDefined(eventValue(event, 'content'), payload?.content);
  const method = firstDefined(eventValue(event, 'method'), payload?.method);
  const name = firstDefined(eventValue(event, 'name'), payload?.name);
  const argumentsValue = firstDefined(eventValue(event, 'arguments'), payload?.arguments);
  const result = firstDefined(eventValue(event, 'result'), payload?.result, payload?.content);
  const error = firstDefined(eventValue(event, 'error'), payload?.error, payload?.message);
  const latencyMs = eventValue(event, 'latencyMs');
  const metadata = firstDefined(eventValue(event, 'metadata'), eventValue(event, 'annotations'));
  const traceId = eventValue(event, 'traceId');
  const parentEventId = eventValue(event, 'parentEventId');

  if (eventId !== undefined) {
    lines.push(`Event ID: ${formatValue(eventId)}`);
  }
  if (content !== undefined) {
    lines.push(`Content: ${formatValue(content)}`);
  }
  if (method !== undefined) {
    lines.push(`Method: ${formatValue(method)}`);
  }
  if (name !== undefined) {
    lines.push(`Name: ${formatValue(name)}`);
  }
  if (argumentsValue !== undefined) {
    lines.push(`Arguments: ${formatValue(argumentsValue)}`);
  }
  if (result !== undefined) {
    lines.push(`Result: ${formatValue(result)}`);
  }
  if (error !== undefined) {
    lines.push(`Error: ${formatValue(error)}`);
  }
  if (latencyMs !== undefined) {
    lines.push(`Latency: ${formatValue(latencyMs)}ms`);
  }
  if (traceId !== undefined) {
    lines.push(`Trace ID: ${formatValue(traceId)}`);
  }
  if (parentEventId !== undefined) {
    lines.push(`Parent Event ID: ${formatValue(parentEventId)}`);
  }
  if (metadata !== undefined) {
    lines.push(`Metadata: ${formatValue(metadata)}`);
  }

  return lines;
}

function toPlayOptions(autoOrOptions: boolean | PlayOptions): PlayOptions {
  return typeof autoOrOptions === 'boolean' ? { auto: autoOrOptions } : autoOrOptions;
}

function normaliseDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('Playback delay must be a non-negative finite number');
  }

  return delayMs;
}

function eventValue(event: SessionEvent, key: string): unknown {
  return (event as unknown as Record<string, unknown>)[key];
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined);
}

function objectValue(event: SessionEvent, key: string): Record<string, unknown> | undefined {
  const value = eventValue(event, key);
  return isRecord(value) ? value : undefined;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function askToContinue(): Promise<PlaybackDecision> {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    terminal.question('Press Enter to continue to next event (or type "q" to quit)... ', (answer) => {
      terminal.close();
      resolve(answer.trim().toLowerCase() === 'q' ? 'quit' : 'continue');
    });
  });
}
