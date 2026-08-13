import {
  compileRedactionConfig,
  CompiledRedactionConfig,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_PATTERNS,
  DebugExport,
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

  public constructor(options: VisReplayOptions = {}) {
    this.redactKeys = normalizeRedactionKeys(options.redactKeys);
    this.redactPatterns = normalizeRedactionPatterns(
      options.redactPatterns,
      options.redactKeys === undefined
    );
    this.redaction = compileRedactionConfig(this.redactKeys, this.redactPatterns);
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

  /** Creates the stable JSON-safe debug report for this session. */
  public exportDebug(): DebugExport {
    return this.session.exportDebug();
  }

  /** Loads a saved session into a usable recorder without adding any events. */
  public static async load(
    filePath: string,
    options: Pick<VisReplayOptions, 'redactKeys' | 'redactPatterns'> = {}
  ): Promise<VisReplay> {
    const redactKeys = normalizeRedactionKeys(options.redactKeys);
    const redactPatterns = normalizeRedactionPatterns(
      options.redactPatterns,
      options.redactKeys === undefined
    );
    const data = await Session.load(filePath, redactKeys, redactPatterns);
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
    } catch {
      // A malformed observation must not alter the wrapped agent's behavior.
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
