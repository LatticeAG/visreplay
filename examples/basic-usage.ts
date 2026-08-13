import { VisReplay } from '../src';
import { resolve } from 'node:path';

class DeploymentAgent {
  async run(task: string): Promise<string> {
    console.log(`[agent] received task: ${task}`);
    return `Completed: ${task}`;
  }
}

async function main(): Promise<void> {
  const recorder = new VisReplay({
    sessionName: 'deploy-staging',
    agentType: 'custom',
  });

  const agent = recorder.wrap(new DeploymentAgent());
  const result = await agent.run('Deploy to staging');

  // Add information the generic method proxy cannot infer.
  recorder.recordReasoning('Tests passed, so staging deployment can proceed.');
  recorder.recordToolCall('deploy', { environment: 'staging' });
  recorder.recordToolResult({ deploymentId: 'dep_123', status: 'complete' });

  const sessionPath = resolve(process.cwd(), 'deploy-staging.vrs');
  await recorder.save(sessionPath);

  const debug = recorder.exportDebug();
  console.log(`Agent returned: ${result}`);
  console.log(`Session saved to ${sessionPath}`);
  console.log(`Recorded ${debug.summary.eventCount} events`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
