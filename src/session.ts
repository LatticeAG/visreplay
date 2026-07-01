import * as fs from 'fs';
import * as path from 'path';
import { SessionData, SessionEvent } from './types';

export class Session {
  public data: SessionData;

  constructor(sessionName: string, agentType?: string) {
    this.data = {
      sessionName,
      startedAt: new Date().toISOString(),
      agentType: agentType || 'unknown',
      events: []
    };
  }

  public addEvent(event: Omit<SessionEvent, 'index' | 'timestamp'>) {
    this.data.events.push({
      ...event,
      timestamp: new Date().toISOString(),
      index: this.data.events.length
    });
  }

  public async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  public static async load(filePath: string): Promise<SessionData> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SessionData;
  }
}
