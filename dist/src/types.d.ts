export type EventType = 'input' | 'reasoning' | 'tool_call' | 'tool_result' | 'output' | 'error';
export interface SessionEvent {
    type: EventType;
    timestamp: string;
    index: number;
    content?: string;
    name?: string;
    arguments?: Record<string, any>;
    result?: any;
    error?: string;
}
export interface SessionData {
    sessionName: string;
    startedAt: string;
    agentType?: string;
    events: SessionEvent[];
}
export interface LexReplayOptions {
    sessionName: string;
    agentType?: string;
}
