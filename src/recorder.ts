import { LexReplayOptions } from './types';
import { Session } from './session';

export class LexReplay {
  private session: Session;

  constructor(options: LexReplayOptions) {
    this.session = new Session(options.sessionName, options.agentType);
  }

  public wrap<T extends object>(agent: T): T {
    const handler: ProxyHandler<T> = {
      get: (target: T, prop: string | symbol, receiver: any) => {
        const originalValue = Reflect.get(target, prop, receiver);

        if (typeof originalValue === 'function') {
          return (...args: any[]) => {
            // Record the input
            this.session.addEvent({
              type: 'input',
              content: JSON.stringify(args)
            });

            try {
              const result = originalValue.apply(target, args);

              if (result instanceof Promise) {
                return result.then(resolved => {
                  this.session.addEvent({
                    type: 'output',
                    content: JSON.stringify(resolved)
                  });
                  return resolved;
                }).catch(err => {
                  this.session.addEvent({
                    type: 'error',
                    error: err instanceof Error ? err.message : String(err)
                  });
                  throw err;
                });
              }

              this.session.addEvent({
                type: 'output',
                content: JSON.stringify(result)
              });
              return result;

            } catch (err) {
              this.session.addEvent({
                type: 'error',
                error: err instanceof Error ? err.message : String(err)
              });
              throw err;
            }
          };
        }

        return originalValue;
      }
    };

    return new Proxy(agent, handler);
  }

  public async save(filePath: string): Promise<void> {
    await this.session.save(filePath);
  }

  // Allow explicit event logging if needed
  public recordReasoning(content: string) {
    this.session.addEvent({ type: 'reasoning', content });
  }

  public recordToolCall(name: string, args: Record<string, any>) {
    this.session.addEvent({ type: 'tool_call', name, arguments: args });
  }

  public recordToolResult(result: any) {
    this.session.addEvent({ type: 'tool_result', result });
  }
}
