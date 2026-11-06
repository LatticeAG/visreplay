const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { VisReplay } = require('../dist');

async function main() {
  const directory = await mkdtemp(join(process.cwd(), '.visreplay-smoke-'));
  try {
    const session = join(directory, 'session.vrs');
    const output = join(directory, 'debug.json');
    const recorder = new VisReplay({ sessionName: 'cli-smoke' });
    recorder.recordReasoning('CLI smoke event');
    recorder.end();
    await recorder.save(session);
    const cli = resolve(__dirname, '../dist/cli.js');
    const replay = execFileSync(process.execPath, [cli, 'replay', session, '--auto'], { encoding: 'utf8' });
    if (!replay.includes('CLI smoke event')) throw new Error('Replay did not contain the recorded event');
    console.log('Replay contained the recorded event');
    process.stdout.write(execFileSync(process.execPath, [cli, 'export', session, '--output', output], { encoding: 'utf8' }));
    const debug = JSON.parse(await readFile(output, 'utf8'));
    if (debug.summary.eventCount !== 1) throw new Error('Export did not contain one event');
    console.log('Export contained one event');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
