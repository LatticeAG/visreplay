import { LexReplay } from '../src/recorder';
import * as path from 'path';

// A simple mock agent class
class MyAgent {
  async run(task: string): Promise<string> {
    console.log(`[Agent] Received task: ${task}`);
    // Simulate some work
    await new Promise(r => setTimeout(r, 1000));
    return `Completed: ${task}`;
  }
}

async function main() {
  const recorder = new LexReplay({ sessionName: 'my-session', agentType: 'custom' });
  
  const myAgentClient = new MyAgent();
  const agent = recorder.wrap(myAgentClient);

  console.log('Running wrapped agent...');
  const result = await agent.run('Deploy to staging');
  
  // You can also manually add agent-specific events
  recorder.recordReasoning('I decided to deploy directly because tests passed.');
  recorder.recordToolCall('execute_deployment', { env: 'staging' });
  recorder.recordToolResult({ success: true, url: 'https://staging.example.com' });

  console.log(`Agent returned: ${result}`);

  const filePath = path.join(__dirname, 'session.json');
  await recorder.save(filePath);
  console.log(`Session saved to ${filePath}`);
}

main().catch(console.error);
