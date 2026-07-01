import { SessionData, SessionEvent } from './types';
export declare class Session {
    data: SessionData;
    constructor(sessionName: string, agentType?: string);
    addEvent(event: Omit<SessionEvent, 'index' | 'timestamp'>): void;
    save(filePath: string): Promise<void>;
    static load(filePath: string): Promise<SessionData>;
}
