import { describe, expect, it } from 'vitest';

import { VisReplay } from './recorder';

describe('WebSocket recording', () => {
  it('records outbound sends and inbound JSON messages through a detachable connection', () => {
    const recorder = new VisReplay();
    const source = new EventEmitterSocket();
    const connection = recorder.recordWebSocket(source, {
      name: 'agent-stream',
      metadata: { channel: 'primary' }
    });

    expect(connection.socket.send('{"token":"hidden","task":"deploy"}')).toBe('sent:1');
    source.emit('message', '{"apiKey":"also-hidden","status":"ready"}');

    expect(source.sent).toEqual(['{"token":"hidden","task":"deploy"}']);
    expect(recorder.getEvents()).toMatchObject([
      {
        type: 'input',
        method: 'agent-stream.send',
        content: { token: '[REDACTED]', task: 'deploy' },
        metadata: { channel: 'primary', transport: 'websocket', direction: 'outbound' }
      },
      {
        type: 'output',
        method: 'agent-stream.message',
        content: { apiKey: '[REDACTED]', status: 'ready' },
        metadata: { channel: 'primary', transport: 'websocket', direction: 'inbound' }
      }
    ]);

    connection.detach();
    connection.detach();
    source.emit('message', 'ignored after detach');

    expect(connection.attached).toBe(false);
    expect(recorder.getEvents()).toHaveLength(2);
  });

  it('works with EventTarget-style sockets and preserves a send method receiver and return value', () => {
    const recorder = new VisReplay({ redactKeys: [] });
    const source = new EventTargetSocket();
    const wrapped = recorder.wrapWebSocket(source, { name: 'browser', parseJson: false });

    expect(wrapped.send('plain request')).toBe('browser:plain request');
    source.dispatch('message', { data: 'plain response' });

    expect(source.lastSent).toBe('plain request');
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'browser.send', content: 'plain request' },
      { type: 'output', method: 'browser.message', content: 'plain response' }
    ]);
  });

  it('records synchronous send failures without replacing the original failure', () => {
    const failure = new Error('socket is closed');
    const source = new EventEmitterSocket(() => {
      throw failure;
    });
    const recorder = new VisReplay();
    const socket = recorder.wrapWebSocket(source, { name: 'failing' });

    expect(() => socket.send('request')).toThrow(failure);
    expect(recorder.getEvents()).toMatchObject([
      { type: 'input', method: 'failing.send', content: 'request' },
      { type: 'error', method: 'failing.send', error: 'socket is closed' }
    ]);
  });

  it('observes safe EventEmitter errors when the application already listens for them', () => {
    const source = new EventEmitterSocket();
    source.on('error', () => undefined);
    const recorder = new VisReplay();
    recorder.recordWebSocket(source, { name: 'event-emitter' });

    source.emit('error', new Error('remote reset'));

    expect(recorder.getEvents()).toMatchObject([
      { type: 'error', method: 'event-emitter.error', error: 'remote reset' }
    ]);
  });

  it('bounds large text frames and supports protocol-specific message transforms', () => {
    const source = new EventEmitterSocket();
    const recorder = new VisReplay({ redactKeys: [] });
    const connection = recorder.recordWebSocket(source, {
      maxPayloadBytes: 5,
      transformMessage: (payload, context) => context.direction === 'inbound'
        ? { body: String(payload), direction: context.direction }
        : payload
    });

    connection.socket.send('too-large');
    source.emit('message', 42);

    expect(recorder.getEvents()).toMatchObject([
      {
        type: 'input',
        content: '[WebSocket payload omitted: 9 bytes exceeds 5-byte limit]'
      },
      {
        type: 'output',
        content: { body: '42', direction: 'inbound' }
      }
    ]);
  });

  it('does not attach the first EventEmitter error listener', () => {
    const source = new EventEmitterSocket();
    const recorder = new VisReplay();
    recorder.recordWebSocket(source, { name: 'quiet' });

    expect(source.listenerCount('error')).toBe(0);
    source.emit('error', new Error('must stay unhandled by instrumentation'));
    expect(recorder.getEvents()).toEqual([]);
  });

  it('forwards WebSocket capture failures to onCaptureError without changing send', () => {
    const captured: Array<{ message: string; type: string }> = [];
    const recorder = new VisReplay({
      onCaptureError(error, event) {
        captured.push({
          message: error instanceof Error ? error.message : String(error),
          type: event.type
        });
      }
    });
    const source = new EventEmitterSocket();
    const socket = recorder.wrapWebSocket(source, { name: 'hooked' });
    const session = (recorder as unknown as { session: { addEvent: (event: unknown) => unknown } }).session;
    session.addEvent = () => {
      throw new Error('socket capture failed');
    };

    expect(socket.send('ping')).toBe('sent:1');
    expect(source.sent).toEqual(['ping']);
    expect(captured).toEqual([{ message: 'socket capture failed', type: 'input' }]);
  });
});

type SocketListener = (...args: unknown[]) => void;

class EventEmitterSocket {
  public readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();

  public constructor(private readonly onSend?: (value: unknown) => void) {}

  public on(event: string, listener: SocketListener): this {
    const eventListeners = this.listeners.get(event) ?? new Set<SocketListener>();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  public off(event: string, listener: SocketListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  public listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  public send(value: unknown): string {
    this.onSend?.(value);
    this.sent.push(value);
    return `sent:${this.sent.length}`;
  }
}

class EventTargetSocket {
  public lastSent: unknown;
  private readonly listeners = new Map<string, Set<SocketListener>>();

  public addEventListener(event: string, listener: SocketListener): void {
    const eventListeners = this.listeners.get(event) ?? new Set<SocketListener>();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
  }

  public removeEventListener(event: string, listener: SocketListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  public dispatch(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }

  public send(value: unknown): string {
    this.lastSent = value;
    return `browser:${String(value)}`;
  }
}
