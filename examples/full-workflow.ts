import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Player, renderExport, VisReplay } from '../src';
// Published consumers import from '@latticeag/visreplay'.

class ReleaseAgent {
  public async run(environment: string): Promise<{ deploymentId: string; status: string }> {
    return {
      deploymentId: `dep_${environment}_001`,
      status: 'complete'
    };
  }
}

async function main(): Promise<void> {
  const outputDirectory = resolve(process.cwd(), 'visreplay-demo');
  const sessionPath = resolve(outputDirectory, 'release.vrs');
  const markdownPath = resolve(outputDirectory, 'release-report.md');
  const htmlPath = resolve(outputDirectory, 'release-timeline.html');

  const recorder = new VisReplay({
    sessionName: 'release-staging',
    agentType: 'example-agent'
  });
  const agent = recorder.wrap(new ReleaseAgent());

  recorder.recordReasoning('The staging checks are green; start the release.');
  recorder.recordDecision({
    believed: { tests: 'green' },
    assumed: { stagingSharesProdCredentials: false },
    ignored: { canary: 'not required for staging' },
    summary: 'Proceed with staging release'
  });
  recorder.recordToolCall('deploy', { environment: 'staging', apiKey: 'example-secret-is-redacted' });
  const result = await agent.run('staging');
  recorder.recordToolResult(result);
  recorder.end();

  await mkdir(outputDirectory, { recursive: true });
  await recorder.save(sessionPath);

  // Replay only reads the saved events; it never calls ReleaseAgent again.
  const player = new Player({ write: (line) => console.log(`[replay] ${line}`) });
  await player.load(sessionPath);
  await player.play({ auto: true });

  const debugExport = recorder.exportDebug();
  await Promise.all([
    writeFile(markdownPath, renderExport(debugExport, 'markdown'), 'utf8'),
    writeFile(htmlPath, renderExport(debugExport, 'html'), 'utf8')
  ]);

  console.log(`Recorded ${debugExport.summary.eventCount} events to ${sessionPath}`);
  console.log(`Wrote ${markdownPath} and ${htmlPath}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
