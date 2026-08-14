import {
  compileRedactionConfig,
  CompiledRedactionConfig,
  DECISION_SCHEMA,
  DecisionInput,
  DecisionRecord,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_PATTERNS,
  DebugExport,
  isRecord,
  LexReplayOptions,
  NewSessionEvent,
  RedactionPattern,
  SessionData,
  SessionEvent,
  toJsonSafe,
  VisReplayOptions
} from './types';
import { Session } from './session';
import {
  attachWebSocket,
  WebSocketRecording,
  WebSocketRecordingOptions
} from './websocket';

/**
 * LatticeAG VisReplay records an agent's method calls into a portable,
 * local-first session. It never sends captured data over the network.
 */
export class VisReplay {
  private session: Session;
  private readonly redactKeys: readonly string[];
  private readonly redactPatterns: readonly RedactionPattern[];
  private readonly redaction: CompiledRedactionConfig;
  private readonly captureErrorHandler?: (error: unknown, event: NewSessionEvent) => void;

  public constructor(options: VisReplayOptions = {}) {
    this.redactKeys = normalizeRedactionKeys(options.redactKeys);
    this.redactPatterns = normalizeRedactionPatterns(
      options.redactPatterns,
      options.redactKeys === undefined
    );
    this.redaction = compileRedactionConfig(this.redactKeys, this.redactPatterns);
    this.captureErrorHandler = options.onCaptureError;
    this.session = new Session(
      options.sessionName ?? 'unnamed-session',
      options.agentType ?? 'unknown',
      options.sessionId,
      this.redactKeys,
      this.redactPatterns
    );
  }

  /**
   * Returns a proxy which records calls to callable own and prototype
   * properties. Non-function property reads retain their normal behavior.
   */
  public wrap<T extends object>(agent: T): T {
    if ((typeof agent !== 'object' && typeof agent !== 'function') || agent === null) {
      throw new Error('VisReplay.wrap requires an object');
    }

    const recorder = this;
    const handler: ProxyHandler<T> = {
      get(target, property, receiver) {
        const originalValue = Reflect.get(target, property, receiver);
        if (typeof originalValue !== 'function') {
          return originalValue;
        }

        return function wrappedMethod(this: unknown, ...args: unknown[]): unknown {
          const method = String(property);
          recorder.captureSafely({ type: 'input', method, content: args });

          let result: unknown;
          try {
            result = Reflect.apply(originalValue, target, args);
          } catch (error) {
            recorder.captureSafely({ type: 'error', method, error: errorToMessage(error) });
            throw error;
          }

          if (observeThenable(
            result,
            value => recorder.captureSafely({ type: 'output', method, content: value }),
            error => recorder.captureSafely({ type: 'error', method, error: errorToMessage(error) })
          )) {
            // Observing a result must not replace the promise or thenable that
            // the original method returned. Callers can rely on its identity
            // and its own scheduling semantics.
            return result;
          }

          recorder.captureSafely({ type: 'output', method, content: result });
          return result;
        };
      }
    };

    return new Proxy(agent, handler);
  }

  /**
   * Attach passive recording to a browser- or Node-style WebSocket.
   * Incoming messages are recorded as outputs and calls to `send()` as inputs.
   * The returned handle owns a proxy socket plus an idempotent detach method.
   */
  public recordWebSocket<T extends object>(
    socket: T,
    options: WebSocketRecordingOptions = {}
  ): WebSocketRecording<T> {
    return attachWebSocket(socket, this, options);
  }

  /**
   * Convenience form of `recordWebSocket` when the caller only needs the
   * proxy socket. Retain the returned connection from `recordWebSocket` when
   * explicit teardown is required.
   */
  public wrapWebSocket<T extends object>(
    socket: T,
    options: WebSocketRecordingOptions = {}
  ): T {
    return this.recordWebSocket(socket, options).socket;
  }

  /** Appends one manually supplied event and returns its assigned snapshot. */
  public log(event: NewSessionEvent): SessionEvent {
    return this.session.addEvent(this.redactEvent(event));
  }

  /** Records an explicit model reasoning observation. */
  public recordReasoning(content: unknown): SessionEvent {
    return this.log({ type: 'reasoning', content });
  }

  /** Records an explicit tool request. */
  public recordToolCall(name: string, args: Record<string, unknown>): SessionEvent {
    return this.log({ type: 'tool_call', name, arguments: args });
  }

  /** Records an explicit tool response. */
  public recordToolResult(result: unknown): SessionEvent {
    return this.log({ type: 'tool_result', result });
  }

  /**
   * Records why an agent acted as a `reasoning` event with
   * `metadata.visreplay` decision data. Session `$schema` stays 1.0.
   */
  public recordDecision(input: DecisionInput): SessionEvent {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Decision input must be an object');
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'believed')) {
      throw new Error('Decision believed is required');
    }
    if (input.confidence !== undefined
      && (typeof input.confidence !== 'number'
        || !Number.isFinite(input.confidence)
        || input.confidence < 0
        || input.confidence > 1)) {
      throw new Error('Decision confidence must be a finite number between 0 and 1');
    }
    if (input.relatedEventIndex !== undefined) {
      const relatedEventIndex = input.relatedEventIndex;
      const eventCount = this.getEvents().length;
      if (!Number.isInteger(relatedEventIndex) || relatedEventIndex < 0 || relatedEventIndex > eventCount - 1) {
        throw new Error(`relatedEventIndex ${relatedEventIndex} is outside the session bounds`);
      }
    }
    if (input.metadata !== undefined && !isRecord(input.metadata)) {
      throw new Error('Decision metadata must be an object');
    }
    if (input.metadata !== undefined && Object.prototype.hasOwnProperty.call(input.metadata, 'visreplay')) {
      throw new Error('metadata.visreplay is reserved for VisReplay');
    }
    if (input.summary !== undefined && typeof input.summary !== 'string') {
      throw new Error('Decision summary must be a string');
    }

    const decisionRecord: DecisionRecord = {
      schema: DECISION_SCHEMA,
      kind: 'decision',
      believed: toJsonSafe(input.believed, this.redaction),
      ...(input.assumed === undefined ? {} : { assumed: toJsonSafe(input.assumed, this.redaction) }),
      ...(input.overweighted === undefined ? {} : { overweighted: toJsonSafe(input.overweighted, this.redaction) }),
      ...(input.ignored === undefined ? {} : { ignored: toJsonSafe(input.ignored, this.redaction) }),
      ...(input.alternatives === undefined ? {} : { alternatives: toJsonSafe(input.alternatives, this.redaction) }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.relatedEventIndex === undefined ? {} : { relatedEventIndex: input.relatedEventIndex }),
      ...(input.summary === undefined ? {} : { summary: input.summary })
    };

    const callerMetadata = input.metadata === undefined
      ? {}
      : toJsonSafe(input.metadata, this.redaction) as Record<string, unknown>;

    return this.log({
      type: 'reasoning',
      content: decisionContent(input.summary, decisionRecord.believed),
      metadata: {
        ...callerMetadata,
        visreplay: decisionRecord
      }
    });
  }

  /** Returns defensive event snapshots in their persisted order. */
  public getEvents(): SessionEvent[] {
    return this.session.getEvents();
  }

  /** Returns a defensive snapshot of the complete current session. */
  public getSession(): SessionData {
    return this.session.getData();
  }

  /** Persists all events currently recorded by this instance. */
  public async save(filePath: string): Promise<void> {
    await this.session.save(filePath);
  }

  /**
   * Marks the logical end of a run once. Later `log` calls still append.
   * `endedAt` stays the first end time. `save()` does not call this.
   */
  public end(): SessionData {
    return this.session.end();
  }

  /** Creates the stable JSON-safe debug report for this session. */
  public exportDebug(): DebugExport {
    return this.session.exportDebug();
  }

  /** Loads a saved session into a usable recorder without adding any events. */
  public static async load(
    filePath: string,
    options: Pick<VisReplayOptions, 'redactKeys' | 'redactPatterns'> & {
      maxFileBytes?: number;
      maxEvents?: number;
    } = {}
  ): Promise<VisReplay> {
    const redactKeys = normalizeRedactionKeys(options.redactKeys);
    const redactPatterns = normalizeRedactionPatterns(
      options.redactPatterns,
      options.redactKeys === undefined
    );
    const data = await Session.load(filePath, {
      redactKeys,
      redactPatterns,
      maxFileBytes: options.maxFileBytes,
      maxEvents: options.maxEvents
    });
    const recorder = new VisReplay({
      sessionId: data.sessionId,
      sessionName: data.sessionName,
      agentType: data.agentType,
      redactKeys: options.redactKeys,
      redactPatterns: options.redactPatterns
    });
    recorder.session = Session.fromData(data, redactKeys, redactPatterns);
    return recorder;
  }

  /**
   * Forward a recording failure from WebSocket observation. A throwing
   * callback is swallowed so socket behavior stays unchanged.
   */
  public onCaptureError(error: unknown, event: NewSessionEvent): void {
    if (this.captureErrorHandler === undefined) {
      return;
    }
    try {
      this.captureErrorHandler(error, event);
    } catch {
      // Callback failures stay instrumentation-only.
    }
  }

  private redactEvent(event: NewSessionEvent): NewSessionEvent {
    if (event === null || typeof event !== 'object') {
      return event;
    }

    const normalized: NewSessionEvent = { ...event };
    if (hasOwn(event, 'content')) normalized.content = toJsonSafe(event.content, this.redaction);
    if (hasOwn(event, 'arguments')) {
      normalized.arguments = toJsonSafe(event.arguments, this.redaction) as Record<string, unknown>;
    }
    if (hasOwn(event, 'result')) normalized.result = toJsonSafe(event.result, this.redaction);
    if (hasOwn(event, 'metadata')) {
      normalized.metadata = toJsonSafe(event.metadata, this.redaction) as Record<string, unknown>;
    }
    return normalized;
  }

  /** Proxy capture must never obscure a wrapped method's return or failure. */
  private captureSafely(event: NewSessionEvent): void {
    try {
      this.log(event);
    } catch (error) {
      this.onCaptureError(error, event);
    }
  }
}

/** @deprecated Use VisReplay. */
export { VisReplay as LexReplay };

/** @deprecated Use VisReplayOptions. */
export type { LexReplayOptions };

function normalizeRedactionKeys(configured: readonly string[] | undefined): readonly string[] {
  const source = configured === undefined ? DEFAULT_REDACT_KEYS : configured;
  if (!Array.isArray(source) || !source.every(key => typeof key === 'string')) {
    throw new TypeError('Redaction keys must be an array of strings');
  }
  return Array.from(new Set(source.map(key => key.toLowerCase())));
}

function normalizeRedactionPatterns(
  configured: readonly RedactionPattern[] | undefined,
  useDefaults: boolean
): readonly RedactionPattern[] {
  const source = configured === undefined
    ? (useDefaults ? DEFAULT_REDACT_PATTERNS : [])
    : configured;
  if (!Array.isArray(source)) {
    throw new TypeError('Redaction patterns must be an array');
  }
  return [...source];
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Attach passive fulfillment and rejection observers without changing the
 * object returned by the wrapped method. A hostile `then` getter or method is
 * treated as a normal synchronous return, because probing it must not turn a
 * successful method call into a throw.
 */
function observeThenable(
  value: unknown,
  onFulfilled: (value: unknown) => void,
  onRejected: (reason: unknown) => void
): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    return false;
  }

  if (typeof then !== 'function') {
    return false;
  }

  let settled = false;
  const fulfill = (result: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    onFulfilled(result);
  };
  const reject = (reason: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    onRejected(reason);
  };

  try {
    const observation = Reflect.apply(then, value, [fulfill, reject]);
    // A native observer promise can reject independently of the observed
    // result. Consume it, but do not assimilate an arbitrary foreign return:
    // probing a second hostile `then` would itself change instrumentation
    // behavior.
    if (observation instanceof Promise) {
      void observation.catch(() => undefined);
    }
    return true;
  } catch {
    return settled;
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  const serialized = toJsonSafe(error);
  try {
    return JSON.stringify(serialized);
  } catch {
    return String(error);
  }
}

function decisionContent(summary: string | undefined, believed: unknown): string {
  if (typeof summary === 'string') {
    return summary;
  }
  try {
    const preview = JSON.stringify(believed);
    if (typeof preview === 'string' && preview.length > 0 && preview !== 'null') {
      return preview.length > 160 ? `${preview.slice(0, 157)}...` : preview;
    }
  } catch {
    // Fall through to the generic marker.
  }
  return 'decision';
}
