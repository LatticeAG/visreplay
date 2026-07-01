import * as readline from 'readline';
import { Session } from './session';
import { SessionData, SessionEvent } from './types';

export class Player {
  private sessionData: SessionData | null = null;

  public async load(filePath: string) {
    this.sessionData = await Session.load(filePath);
    console.log(`Loaded session: ${this.sessionData.sessionName} (${this.sessionData.events.length} events)`);
  }

  public async play(auto: boolean = false) {
    if (!this.sessionData) {
      throw new Error('No session loaded');
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const askToContinue = () => new Promise<void>(resolve => {
      rl.question('Press Enter to continue to next event (or type "q" to quit)...', answer => {
        if (answer.toLowerCase() === 'q') {
          process.exit(0);
        }
        resolve();
      });
    });

    for (const event of this.sessionData.events) {
      this.printEvent(event);
      if (!auto) {
        await askToContinue();
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log('\n--- End of Session ---');
    rl.close();
  }

  private printEvent(event: SessionEvent) {
    console.log(`\n[${event.timestamp}] EVENT: ${event.type.toUpperCase()} (Index: ${event.index})`);
    if (event.content) console.log(`Content: ${event.content}`);
    if (event.name) console.log(`Name: ${event.name}`);
    if (event.arguments) console.log(`Arguments: ${JSON.stringify(event.arguments, null, 2)}`);
    if (event.result) console.log(`Result: ${JSON.stringify(event.result, null, 2)}`);
    if (event.error) console.log(`Error: ${event.error}`);
  }
}
