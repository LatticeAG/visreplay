import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CliIO,
  createProgram,
  defaultDebugViewerPath,
  parseExportFormat,
  parseReplayDelay,
  runCli,
  writeDebugExport
} from './cli';
import { Session } from './session';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('visreplay CLI', () => {
  it('constructs an import-safe program with only local v1 commands', () => {
    const program = createProgram({ io: createMemoryIO() });

    expect(program.name()).toBe('visreplay');
    expect(program.commands.map((command) => command.name())).toEqual(['replay', 'export', 'debug', 'compare']);
    expect(program.description()).toContain('LatticeAG VisReplay');
  });

  it('replays a saved session automatically through the CLI', async () => {
    const filePath = await createSessionFile();
    const io = createMemoryIO();

    await runCli(['replay', filePath, '--auto'], { io });

    const output = io.stdout();
    expect(output).toContain('Loaded session: cli-test (2 events)');
    expect(output).toContain('Content: deploy');
    expect(output).toContain('Content: complete');
    expect(output).toContain('--- End of Session ---');
  });

  it('exports debug JSON to stdout without replay status text', async () => {
    const io = createMemoryIO();
    const debugExport = {
      $schema: 'visreplay/debug/1.0',
      session: { sessionName: 'stdout-test' },
      timeline: []
    };

    await runCli(['export', 'session.vrs'], {
      io,
      loadDebugSource: async () => ({ exportDebug: () => debugExport })
    });

    expect(io.stdout()).toBe(`${JSON.stringify(debugExport, null, 2)}\n`);
    expect(io.stderr()).toBe('');
  });

  it('writes debug JSON to an output file and reports the destination', async () => {
    const directory = await createTemporaryDirectory();
    const outputPath = join(directory, 'nested', 'debug.json');
    const io = createMemoryIO();
    const debugExport = { $schema: 'visreplay/debug/1.0', timeline: [{ index: 0 }] };

    await runCli(['export', 'session.vrs', '--output', outputPath], {
      io,
      loadDebugSource: async () => ({ exportDebug: async () => debugExport })
    });

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(debugExport);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(io.stdout()).toBe(`Exported debug session to ${outputPath}\n`);
  });

  it('exports Markdown reports and HTML timelines without changing the JSON default', async () => {
    const directory = await createTemporaryDirectory();
    const markdownPath = join(directory, 'reports', 'session.md');
    const debugExport = createDebugExport();
    const markdownIO = createMemoryIO();

    await runCli(['export', 'session.vrs', '--format', 'markdown', '--output', markdownPath], {
      io: markdownIO,
      loadDebugSource: async () => ({ exportDebug: () => debugExport })
    });

    const markdown = await readFile(markdownPath, 'utf8');
    expect(markdown).toContain('# VisReplay Debug Report');
    expect(markdown).toContain('| Events | 2 |');
    expect(markdown).toContain('### Event 1 — `output`');
    expect(markdownIO.stdout()).toBe(`Exported Markdown report to ${markdownPath}\n`);

    const htmlIO = createMemoryIO();
    await runCli(['export', 'session.vrs', '--format', 'html'], {
      io: htmlIO,
      loadDebugSource: async () => ({ exportDebug: () => debugExport })
    });

    expect(htmlIO.stdout()).toContain('<!doctype html>');
    expect(htmlIO.stdout()).toContain('VisReplay timeline');
    expect(htmlIO.stdout()).toContain('Raw event');
    expect(htmlIO.stderr()).toBe('');
  });

  it('generates a self-contained, interactive and script-safe debug viewer', async () => {
    const directory = await createTemporaryDirectory();
    const outputPath = join(directory, 'viewer', 'session.debug.html');
    const io = createMemoryIO();
    const debugExport = createDebugExport({ sessionName: '</script><img src=x onerror=alert(1)>\u2028\u2029' });

    await runCli(['debug', 'session.vrs', '--output', outputPath], {
      io,
      loadDebugSource: async () => ({ exportDebug: () => debugExport })
    });

    const viewer = await readFile(outputPath, 'utf8');
    expect(viewer).toContain('<!doctype html>');
    expect(viewer).toContain('data-filter="tool_call"');
    expect(viewer).toContain('Full recorded event');
    expect(viewer).toContain('\\u003c/script\\u003e');
    expect(viewer).toContain('\\u2028');
    expect(viewer).toContain('\\u2029');
    expect(viewer).not.toContain('</script><img src=x');
    expect(viewer).not.toContain('\u2028');
    expect(viewer).not.toContain('\u2029');
    expect(io.stdout()).toBe(`Generated interactive debug viewer at ${outputPath}\n`);
  });

  it('uses an adjacent .debug.html path when debug output is omitted', async () => {
    const directory = await createTemporaryDirectory();
    const sessionPath = join(directory, 'nested', 'recording.vrs');
    const expectedPath = join(directory, 'nested', 'recording.debug.html');
    const io = createMemoryIO();

    expect(defaultDebugViewerPath(sessionPath)).toBe(expectedPath);
    await runCli(['debug', sessionPath], {
      io,
      loadDebugSource: async () => ({ exportDebug: () => createDebugExport() })
    });

    expect(await readFile(expectedPath, 'utf8')).toContain('VisReplay debug viewer');
    expect(io.stdout()).toBe(`Generated interactive debug viewer at ${expectedPath}\n`);
  });

  it('validates requested export formats before executing a command', async () => {
    expect(parseExportFormat('JSON')).toBe('json');
    expect(parseExportFormat('md')).toBe('markdown');
    expect(parseExportFormat('htm')).toBe('html');
    expect(() => parseExportFormat('pdf')).toThrow('format must be one of');

    const io = createMemoryIO();
    await expect(runCli(['export', 'session.vrs', '--format', 'pdf'], { io }))
      .rejects.toThrow('format must be one of');
    expect(io.stderr()).toContain('format must be one of');
  });

  it('compares two recordings through the CLI and supports a compact file export', async () => {
    const directory = await createTemporaryDirectory();
    const outputPath = join(directory, 'comparison', 'diff.json');
    const io = createMemoryIO();
    const comparison = {
      equal: false,
      summary: {
        baselineEventCount: 1,
        candidateEventCount: 2,
        unchanged: 1,
        changed: 0,
        added: 1,
        removed: 0,
        metadataChanges: 0
      },
      metadata: [],
      events: [{ kind: 'added', candidateIndex: 1, changes: [] }]
    };
    const calls: Array<{
      baseline: string;
      candidate: string;
      options: {
        includeUnchanged?: boolean;
        compareTimestamps?: boolean;
        compareIdentifiers?: boolean;
      };
    }> = [];

    await runCli([
      'compare',
      'baseline.vrs',
      'candidate.vrs',
      '--changes-only',
      '--timestamps',
      '--identifiers',
      '--output',
      outputPath
    ], {
      io,
      compareSessionFiles: async (baseline, candidate, options) => {
        calls.push({ baseline, candidate, options: options ?? {} });
        return comparison;
      }
    });

    expect(calls).toEqual([{
      baseline: 'baseline.vrs',
      candidate: 'candidate.vrs',
      options: {
        includeUnchanged: false,
        compareTimestamps: true,
        compareIdentifiers: true
      }
    }]);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(comparison);
    expect(io.stdout()).toBe(`Exported session comparison to ${outputPath}\n`);
  });

  it('validates automatic replay delay values before executing a command', () => {
    expect(parseReplayDelay('12')).toBe(12);
    expect(() => parseReplayDelay('-1')).toThrow('delay must be a non-negative integer');
    expect(() => parseReplayDelay('not-a-number')).toThrow('delay must be a non-negative integer');
  });

  it('reports command parsing failures without terminating the embedding process', async () => {
    const io = createMemoryIO();

    await expect(runCli(['replay', 'session.vrs', '--delay', '-1'], { io }))
      .rejects.toThrow('delay must be a non-negative integer');

    expect(io.stderr()).toContain('delay must be a non-negative integer');
  });

  it('writes formatted debug JSON atomically to a new directory', async () => {
    const directory = await createTemporaryDirectory();
    const outputPath = join(directory, 'debug', 'trace.json');
    const debugExport = { session: 'atomic-test', events: [{ index: 0 }] };

    await writeDebugExport(outputPath, debugExport);

    expect(await readFile(outputPath, 'utf8')).toBe(`${JSON.stringify(debugExport, null, 2)}\n`);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects an empty debug export path', async () => {
    await expect(writeDebugExport('   ', {})).rejects.toThrow('A debug export path is required');
  });
});

function createMemoryIO(): CliIO & { stdout(): string; stderr(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    write: (chunk) => stdout.push(chunk),
    error: (chunk) => stderr.push(chunk),
    stdout: () => stdout.join(''),
    stderr: () => stderr.join('')
  };
}

async function createSessionFile(): Promise<string> {
  const directory = await createTemporaryDirectory();
  const filePath = join(directory, 'session.vrs');
  const session = new Session('cli-test', 'test-agent');
  session.addEvent({ type: 'input', content: 'deploy' });
  session.addEvent({ type: 'output', content: 'complete' });
  await session.save(filePath);
  return filePath;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'visreplay-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createDebugExport(session: { sessionName?: string } = {}): Record<string, unknown> {
  return {
    $schema: 'visreplay/debug/1.0',
    session: {
      sessionId: 'ses_cli_export',
      sessionName: session.sessionName ?? 'export-test',
      agentType: 'test-agent',
      startedAt: '2026-07-21T09:00:00.000Z'
    },
    summary: {
      eventCount: 2,
      eventCounts: {
        input: 1,
        reasoning: 0,
        tool_call: 0,
        tool_result: 0,
        output: 1,
        error: 0
      },
      errorCount: 0
    },
    timeline: [
      {
        index: 0,
        timestamp: '2026-07-21T09:00:00.000Z',
        type: 'input',
        method: 'run',
        preview: 'deploy staging'
      },
      {
        index: 1,
        timestamp: '2026-07-21T09:00:01.000Z',
        type: 'output',
        method: 'run',
        preview: 'done'
      }
    ],
    events: [
      {
        eventId: 'evt_0',
        index: 0,
        timestamp: '2026-07-21T09:00:00.000Z',
        type: 'input',
        method: 'run',
        content: ['deploy staging']
      },
      {
        eventId: 'evt_1',
        index: 1,
        timestamp: '2026-07-21T09:00:01.000Z',
        type: 'output',
        method: 'run',
        content: 'done'
      }
    ]
  };
}
