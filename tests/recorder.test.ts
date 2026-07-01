import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { LexReplay } from '../src/recorder';

test('LexReplay basic wrapper test', async () => {
  const recorder = new LexReplay({ sessionName: 'test-session', agentType: 'mock' });
  
  class MockAgent {
    async run(input: string) {
      return `Processed: ${input}`;
    }
  }

  const agent = new MockAgent();
  const wrappedAgent = recorder.wrap(agent);

  const result = await wrappedAgent.run('Hello');
  assert.strictEqual(result, 'Processed: Hello');

  const filePath = path.join(__dirname, 'test-session.json');
  await recorder.save(filePath);

  assert.ok(fs.existsSync(filePath), 'Session file should have been created');
  
  const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(content.sessionName, 'test-session');
  assert.strictEqual(content.events.length, 2);
  assert.strictEqual(content.events[0].type, 'input');
  assert.strictEqual(content.events[1].type, 'output');

  // cleanup
  fs.unlinkSync(filePath);
});
