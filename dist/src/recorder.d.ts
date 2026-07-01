import { LexReplayOptions } from './types';
export declare class LexReplay {
    private session;
    constructor(options: LexReplayOptions);
    wrap<T extends object>(agent: T): T;
    save(filePath: string): Promise<void>;
    recordReasoning(content: string): void;
    recordToolCall(name: string, args: Record<string, any>): void;
    recordToolResult(result: any): void;
}
