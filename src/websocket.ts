import { NewSessionEvent } from './types';

/** Direction of a message observed on a WebSocket connection. */
export type WebSocketDirection = 'inbound' | 'outbound';

/** Context supplied when an application wants to decode a socket payload. */
export interface WebSocketMessageContext {
  direction: WebSocketDirection;
  socketName: string;
}

/**
 * Options for recording a WebSocket-shaped object. Both browser/EventTarget
 * sockets and Node EventEmitter-style sockets are supported without taking a
 * runtime dependency on a particular WebSocket package.
 */
export interface WebSocketRecordingOptions {
  /** A readable label used in the recorded event method names. */
  name?: string;
  /** Parse JSON text messages before redaction and persistence. Defaults to true. */
  parseJson?: boolean;
  /**
   * Maximum retained text payload size. Oversized messages are represented by
   * a visible marker instead of retaining a potentially unbounded string.
   */
  maxPayloadBytes?: number;
  /** Extra metadata added to every socket event. */
  metadata?: Record<string, unknown>;
  /** Decode an application-specific message protocol before it is recorded. */
  transformMessage?: (payload: unknown, context: WebSocketMessageContext) => unknown;
}

/** A detachable socket recording connection returned by `recordWebSocket`. */
export interface WebSocketRecording<T extends object> {
  /** A proxy that observes outgoing `send()` calls while preserving the socket API. */
  socket: T;
  /** Remove passive message/error observers. Safe to call more than once. */
  detach(): void;
  /** Whether passive observers remain attached. */
  readonly attached: boolean;
}

/** Minimal sink implemented by VisReplay and useful for custom integrations. */
export interface WebSocketEventSink {
  log(event: NewSessionEvent): unknown;
  onCaptureError?(error: unknown, event: NewSessionEvent): void;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Attach passive recording to a WebSocket-shaped object.
 *
 * Incoming messages become `output` events and outgoing `send()` calls become
 * `input` events. The returned proxy preserves the original socket's method
 * receiver and return values. Consumers can call `detach()` when a connection
 * is no longer relevant to the recording.
 */
export function attachWebSocket<T extends object>(
  socket: T,
  sink: WebSocketEventSink,
  options: WebSocketRecordingOptions = {}
): WebSocketRecording<T> {
  if (socket === null || typeof socket !== 'object') {
    throw new TypeError('A WebSocket object is required');
  }
  if (sink === null || typeof sink !== 'object' || typeof sink.log !== 'function') {
    throw new TypeError('A WebSocket event sink with a log method is required');
  }

  const configuration = normalizeOptions(options);
  const listeners: Array<() => void> = [];
  let attached = true;

  const report = (event: NewSessionEvent): void => {
    try {
      sink.log(event);
    } catch (error) {
      try {
        sink.onCaptureError?.(error, event);
      } catch {
        // Callback failures stay instrumentation-only.
      }
    }
  };

  const recordMessage = (payload: unknown, direction: WebSocketDirection): void => {
    let content: unknown;
    try {
      content = normalizePayload(payload, direction, configuration);
    } catch (error) {
      report({
        type: 'error',
        method: `${configuration.name}.decode`,
        error: errorMessage(error),
        metadata: eventMetadata(configuration, direction)
      });
      return;
    }

    report({
      type: direction === 'outbound' ? 'input' : 'output',
      method: `${configuration.name}.${direction === 'outbound' ? 'send' : 'message'}`,
      content,
      metadata: eventMetadata(configuration, direction)
    });
  };

  try {
    listeners.push(addSocketListener(socket, 'message', (...args) => {
      recordMessage(extractIncomingPayload(args), 'inbound');
    }));
  } catch (error) {
    throw new TypeError(`Unable to observe WebSocket messages: ${errorMessage(error)}`);
  }

  // EventTarget errors are ordinary events. Node EventEmitter's `error`
  // event is special: adding the first listener changes its unhandled-error
  // semantics, so only attach when an application listener already exists.
  const errorUnsubscribe = addErrorListenerIfSafe(socket, (reason) => {
    report({
      type: 'error',
      method: `${configuration.name}.error`,
      error: errorMessage(reason),
      metadata: eventMetadata(configuration)
    });
  });
  if (errorUnsubscribe) {
    listeners.push(errorUnsubscribe);
  }

  const proxy = new Proxy(socket, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'send' || typeof value !== 'function') {
        return value;
      }

      return function recordedSend(this: unknown, ...args: unknown[]): unknown {
        recordMessage(args[0], 'outbound');
        try {
          const result = Reflect.apply(value, target, args);
          // A few client implementations make send asynchronous. Observing a
          // native Promise preserves the caller-visible promise while still
          // retaining an eventual transport failure in the recording.
          if (result instanceof Promise) {
            void result.catch((error: unknown) => {
              report({
                type: 'error',
                method: `${configuration.name}.send`,
                error: errorMessage(error),
                metadata: eventMetadata(configuration, 'outbound')
              });
            });
          }
          return result;
        } catch (error) {
          report({
            type: 'error',
            method: `${configuration.name}.send`,
            error: errorMessage(error),
            metadata: eventMetadata(configuration, 'outbound')
          });
          throw error;
        }
      };
    }
  });

  return {
    socket: proxy,
    detach: () => {
      if (!attached) {
        return;
      }
      attached = false;
      for (const unsubscribe of listeners.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // A socket might already have been disposed; detaching remains safe.
        }
      }
    },
    get attached(): boolean {
      return attached;
    }
  };
}

interface NormalizedOptions {
  name: string;
  parseJson: boolean;
  maxPayloadBytes: number;
  metadata: Record<string, unknown>;
  transformMessage?: WebSocketRecordingOptions['transformMessage'];
}

type SocketListener = (...args: unknown[]) => void;

function normalizeOptions(options: WebSocketRecordingOptions): NormalizedOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('WebSocket recording options must be an object');
  }

  const name = options.name ?? 'websocket';
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('WebSocket recording name must be a non-empty string');
  }
  if (options.parseJson !== undefined && typeof options.parseJson !== 'boolean') {
    throw new TypeError('WebSocket parseJson must be a boolean');
  }
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new RangeError('WebSocket maxPayloadBytes must be a positive safe integer');
  }
  if (options.metadata !== undefined && !isRecord(options.metadata)) {
    throw new TypeError('WebSocket metadata must be an object');
  }
  if (options.transformMessage !== undefined && typeof options.transformMessage !== 'function') {
    throw new TypeError('WebSocket transformMessage must be a function');
  }

  return {
    name: name.trim(),
    parseJson: options.parseJson ?? true,
    maxPayloadBytes,
    metadata: { ...(options.metadata ?? {}) },
    ...(options.transformMessage === undefined ? {} : { transformMessage: options.transformMessage })
  };
}

function eventMetadata(
  options: NormalizedOptions,
  direction?: WebSocketDirection
): Record<string, unknown> {
  return {
    ...options.metadata,
    transport: 'websocket',
    ...(direction === undefined ? {} : { direction })
  };
}

function normalizePayload(
  payload: unknown,
  direction: WebSocketDirection,
  options: NormalizedOptions
): unknown {
  const context: WebSocketMessageContext = { direction, socketName: options.name };
  const transformed = options.transformMessage
    ? options.transformMessage(payload, context)
    : payload;

  if (typeof transformed === 'string') {
    if (byteLength(transformed) > options.maxPayloadBytes) {
      return `[WebSocket payload omitted: ${byteLength(transformed)} bytes exceeds ${options.maxPayloadBytes}-byte limit]`;
    }
    if (options.parseJson) {
      try {
        return JSON.parse(transformed) as unknown;
      } catch {
        // Not every WebSocket text frame is JSON; preserving text is useful.
      }
    }
    return transformed;
  }

  if (isBinaryPayload(transformed)) {
    return {
      $type: 'WebSocketBinary',
      byteLength: binaryByteLength(transformed)
    };
  }

  return transformed;
}

function extractIncomingPayload(args: unknown[]): unknown {
  const first = args[0];
  if (isRecord(first) && 'data' in first) {
    try {
      return first.data;
    } catch {
      return '[Unreadable WebSocket message data]';
    }
  }
  return first;
}

function addSocketListener(socket: object, event: string, listener: SocketListener): () => void {
  const candidate = socket as Record<string, unknown>;
  const addEventListener = candidate.addEventListener;
  const removeEventListener = candidate.removeEventListener;
  if (typeof addEventListener === 'function') {
    Reflect.apply(addEventListener, socket, [event, listener]);
    return () => {
      if (typeof removeEventListener === 'function') {
        Reflect.apply(removeEventListener, socket, [event, listener]);
      }
    };
  }

  const on = candidate.on;
  const off = candidate.off;
  const removeListener = candidate.removeListener;
  if (typeof on === 'function') {
    Reflect.apply(on, socket, [event, listener]);
    return () => {
      if (typeof off === 'function') {
        Reflect.apply(off, socket, [event, listener]);
      } else if (typeof removeListener === 'function') {
        Reflect.apply(removeListener, socket, [event, listener]);
      }
    };
  }

  throw new Error('socket must implement addEventListener() or on()');
}

function addErrorListenerIfSafe(socket: object, listener: (reason: unknown) => void): (() => void) | undefined {
  const candidate = socket as Record<string, unknown>;
  if (typeof candidate.addEventListener === 'function') {
    return addSocketListener(socket, 'error', (event) => {
      const eventRecord = isRecord(event) ? event : undefined;
      listener(eventRecord?.error ?? eventRecord?.message ?? event);
    });
  }

  const listenerCount = candidate.listenerCount;
  if (typeof listenerCount !== 'function') {
    return undefined;
  }

  try {
    const existing = Reflect.apply(listenerCount, socket, ['error']);
    if (typeof existing === 'number' && existing > 0) {
      return addSocketListener(socket, 'error', listener);
    }
  } catch {
    // Error observation is optional; message capture remains available.
  }
  return undefined;
}

function isBinaryPayload(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function binaryByteLength(value: ArrayBuffer | ArrayBufferView): number {
  return value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
