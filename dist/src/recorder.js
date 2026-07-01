"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LexReplay = void 0;
const session_1 = require("./session");
class LexReplay {
    session;
    constructor(options) {
        this.session = new session_1.Session(options.sessionName, options.agentType);
    }
    wrap(agent) {
        const handler = {
            get: (target, prop, receiver) => {
                const originalValue = Reflect.get(target, prop, receiver);
                if (typeof originalValue === 'function') {
                    return (...args) => {
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
                        }
                        catch (err) {
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
    async save(filePath) {
        await this.session.save(filePath);
    }
    // Allow explicit event logging if needed
    recordReasoning(content) {
        this.session.addEvent({ type: 'reasoning', content });
    }
    recordToolCall(name, args) {
        this.session.addEvent({ type: 'tool_call', name, arguments: args });
    }
    recordToolResult(result) {
        this.session.addEvent({ type: 'tool_result', result });
    }
}
exports.LexReplay = LexReplay;
