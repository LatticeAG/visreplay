#!/usr/bin/env node

import { extname, join } from 'node:path';

import { Command, CommanderError, InvalidArgumentError } from 'commander';

import { SessionData } from './types';
import { writeTextAtomically } from './atomic-write';
import { compareSessionFiles, SessionFileComparisonOptions } from './diff';
import { Player, PlayerWriter } from './player';
import { VisReplay } from './recorder';
import { renderInterop } from './interop';
import {
  ExportFormat,
  isInteropExportFormat,
  parseExportFormat,
  renderDebugViewer,
  renderExport
} from './render';

export {
  parseExportFormat,
  renderDebugViewer,
  renderExport,
  renderHtmlTimeline,
  renderMarkdownReport
} from './render';
export type { ExportFormat } from './render';

/** Output destination for the command-line interface. */
export interface CliIO {
  write(chunk: string): void;
  error(chunk: string): void;
}

/** Minimal contract used by export and debug commands and convenient for CLI embedding. */
export interface DebugExportSource {
  exportDebug(): unknown | Promise<unknown>;
}

export interface CreateProgramOptions {
  io?: CliIO;
  createPlayer?: (write: PlayerWriter) => Player;
  loadDebugSource?: (filePath: string) => Promise<DebugExportSource>;
  loadSessionSource?: (filePath: string) => Promise<{ getSession(): SessionData }>;
  compareSessionFiles?: (
    baselineFilePath: string,
    candidateFilePath: string,
    options?: SessionFileComparisonOptions
  ) => Promise<unknown>;
}

const terminalIO: CliIO = {
  write: (chunk) => process.stdout.write(chunk),
  error: (chunk) => process.stderr.write(chunk)
};

/**
 * Create, but do not parse, the visreplay CLI program. Keeping construction
 * separate from execution makes the CLI safe to import and straightforward to
 * embed in another Node.js command.
 */
export function createProgram(options: CreateProgramOptions = {}): Command {
  const io = options.io ?? terminalIO;
  const compareFiles = options.compareSessionFiles ?? compareSessionFiles;
  const program = new Command();

  program
    .name('visreplay')
    .description('LatticeAG VisReplay - record, replay, and debug agent sessions')
    .version(readPackageVersion())
    .configureOutput({
      writeOut: (chunk) => io.write(chunk),
      writeErr: (chunk) => io.error(chunk)
    })
    .exitOverride();

  const replayCommand = program
    .command('replay')
    .description('Replay a recorded local session')
    .argument('<file>', 'Path to a .vrs session file')
    .option('--auto', 'Play through automatically without waiting for input', false)
    .option('--delay <milliseconds>', 'Delay between automatically replayed events', parseReplayDelay)
    .option('--max-file-bytes <bytes>', 'Maximum session file size in bytes', parseLimitOption('max-file-bytes'))
    .option('--max-events <count>', 'Maximum number of events to load', parseLimitOption('max-events'))
    .action(async (file: string, commandOptions: { auto: boolean; delay?: number; maxFileBytes?: number; maxEvents?: number }) => {
      const player = options.createPlayer
        ? options.createPlayer((line) => io.write(`${line}\n`))
        : new Player({
          write: (line) => io.write(`${line}\n`),
          ...loadLimitOptions(commandOptions)
        });
      await player.load(file);
      await player.play({
        auto: commandOptions.auto,
        delayMs: commandOptions.delay
      });
    });
  replayCommand.exitOverride();

  const exportCommand = program
    .command('export')
    .description('Export a session as debug JSON, Markdown, HTML, or a vendor interop file')
    .argument('<file>', 'Path to a .vrs session file')
    .option('-o, --output <path>', 'Write the export to this path instead of stdout')
    .option('-f, --format <format>', 'Export format: json, markdown, html, langfuse, otlp, or langsmith', parseCliExportFormat, 'json')
    .option('--max-file-bytes <bytes>', 'Maximum session file size in bytes', parseLimitOption('max-file-bytes'))
    .option('--max-events <count>', 'Maximum number of events to load', parseLimitOption('max-events'))
    .action(async (file: string, commandOptions: { output?: string; format?: ExportFormat; maxFileBytes?: number; maxEvents?: number }) => {
      const format = commandOptions.format ?? 'json';
      const contents = isInteropExportFormat(format)
        ? await renderInteropExport(file, format, options, commandOptions)
        : await renderDebugExportContents(file, format, options, commandOptions);

      if (commandOptions.output) {
        await writeExportFile(commandOptions.output, contents);
        io.write(`${exportConfirmation(format)} ${commandOptions.output}\n`);
        return;
      }

      io.write(contents);
    });
  exportCommand.exitOverride();

  const debugCommand = program
    .command('debug')
    .description('Generate a self-contained interactive HTML debug viewer for a session')
    .argument('<file>', 'Path to a .vrs session file')
    .option('-o, --output <path>', 'Write the interactive viewer to this path')
    .option('--max-file-bytes <bytes>', 'Maximum session file size in bytes', parseLimitOption('max-file-bytes'))
    .option('--max-events <count>', 'Maximum number of events to load', parseLimitOption('max-events'))
    .action(async (file: string, commandOptions: { output?: string; maxFileBytes?: number; maxEvents?: number }) => {
      const source = options.loadDebugSource
        ? await options.loadDebugSource(file)
        : await VisReplay.load(file, loadLimitOptions(commandOptions));
      const debugExport = await source.exportDebug();
      const outputPath = commandOptions.output ?? defaultDebugViewerPath(file);

      await writeExportFile(outputPath, `${renderDebugViewer(debugExport)}\n`);
      io.write(`Generated interactive debug viewer at ${outputPath}\n`);
    });
  debugCommand.exitOverride();

  const compareCommand = program
    .command('compare')
    .description('Compare two local session recordings and emit a deterministic JSON diff')
    .argument('<baseline>', 'Path to the baseline .vrs session file')
    .argument('<candidate>', 'Path to the candidate .vrs session file')
    .option('-o, --output <path>', 'Write comparison JSON to this path instead of stdout')
    .option('--changes-only', 'Omit unchanged event pairs from the comparison output', false)
    .option('--timestamps', 'Include timestamps in the comparison', false)
    .option('--identifiers', 'Include generated session and event IDs in the comparison', false)
    .option('--max-file-bytes <bytes>', 'Maximum session file size in bytes', parseLimitOption('max-file-bytes'))
    .option('--max-events <count>', 'Maximum number of events to load', parseLimitOption('max-events'))
    .action(async (
      baseline: string,
      candidate: string,
      commandOptions: {
        output?: string;
        changesOnly: boolean;
        timestamps: boolean;
        identifiers: boolean;
        maxFileBytes?: number;
        maxEvents?: number;
      }
    ) => {
      const comparisonOptions: SessionFileComparisonOptions = {
        ...(commandOptions.changesOnly ? { includeUnchanged: false } : {}),
        ...(commandOptions.timestamps ? { compareTimestamps: true } : {}),
        ...(commandOptions.identifiers ? { compareIdentifiers: true } : {}),
        ...loadLimitOptions(commandOptions)
      };
      const comparison = await compareFiles(baseline, candidate, comparisonOptions);
      const contents = `${stringifyJson(comparison, 2)}\n`;

      if (commandOptions.output) {
        await writeExportFile(commandOptions.output, contents);
        io.write(`Exported session comparison to ${commandOptions.output}\n`);
        return;
      }

      io.write(contents);
    });
  compareCommand.exitOverride();

  return program;
}

function readPackageVersion(): string {
  try {
    const pkg = require(join(__dirname, '..', 'package.json')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version;
    }
  } catch {
    // Missing package.json must not crash CLI construction.
  }
  return '0.0.0-unknown';
}

/** Parse CLI arguments without terminating the host process. */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  options: CreateProgramOptions = {}
): Promise<void> {
  const program = createProgram(options);
  await program.parseAsync([...argv], { from: 'user' });
}


/** Choose a predictable adjacent destination when `visreplay debug` has no output flag. */
export function defaultDebugViewerPath(sessionFilePath: string): string {
  const extension = extname(sessionFilePath);
  const stem = extension.length > 0 ? sessionFilePath.slice(0, -extension.length) : sessionFilePath;
  return `${stem}.debug.html`;
}

/** Write arbitrary export text atomically so a failed write cannot corrupt a prior export. */
export async function writeExportFile(filePath: string, contents: string): Promise<void> {
  if (!filePath.trim()) {
    throw new TypeError('An export path is required');
  }

  await writeTextAtomically(filePath, contents);
}

/** Write formatted debug JSON atomically so a failed export cannot corrupt a prior file. */
export async function writeDebugExport(filePath: string, debugExport: unknown): Promise<void> {
  if (!filePath.trim()) {
    throw new TypeError('A debug export path is required');
  }

  await writeTextAtomically(filePath, `${stringifyJson(debugExport, 2)}\n`);
}

/** Parse the replay delay option and reject values that cannot be scheduled safely. */
export function parseReplayDelay(value: string): number {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0 || !Number.isInteger(delay)) {
    throw new InvalidArgumentError('delay must be a non-negative integer number of milliseconds');
  }

  return delay;
}

function parseCliExportFormat(value: string): ExportFormat {
  try {
    return parseExportFormat(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function exportConfirmation(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return 'Exported debug session to';
    case 'markdown':
      return 'Exported Markdown report to';
    case 'html':
      return 'Exported HTML timeline to';
    case 'langfuse':
      return 'Exported Langfuse ingestion batch to';
    case 'otlp':
      return 'Exported OTLP JSON trace to';
    case 'langsmith':
      return 'Exported LangSmith run list to';
  }
}

function parseLimitOption(label: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new InvalidArgumentError(`${label} must be a non-negative safe integer`);
    }
    return parsed;
  };
}

function loadLimitOptions(commandOptions: { maxFileBytes?: number; maxEvents?: number }): {
  maxFileBytes?: number;
  maxEvents?: number;
} {
  return {
    ...(commandOptions.maxFileBytes === undefined ? {} : { maxFileBytes: commandOptions.maxFileBytes }),
    ...(commandOptions.maxEvents === undefined ? {} : { maxEvents: commandOptions.maxEvents })
  };
}

async function renderDebugExportContents(
  file: string,
  format: ExportFormat,
  programOptions: CreateProgramOptions,
  commandOptions: { maxFileBytes?: number; maxEvents?: number }
): Promise<string> {
  const source = programOptions.loadDebugSource
    ? await programOptions.loadDebugSource(file)
    : await VisReplay.load(file, loadLimitOptions(commandOptions));
  const debugExport = await source.exportDebug();
  return renderExport(debugExport, format);
}

async function renderInteropExport(
  file: string,
  format: 'langfuse' | 'otlp' | 'langsmith',
  programOptions: CreateProgramOptions,
  commandOptions: { maxFileBytes?: number; maxEvents?: number }
): Promise<string> {
  const source = programOptions.loadSessionSource
    ? await programOptions.loadSessionSource(file)
    : await VisReplay.load(file, loadLimitOptions(commandOptions));
  return renderInterop(source.getSession(), format);
}

function stringifyJson(value: unknown, space: number): string {
  try {
    return JSON.stringify(value, null, space) ?? 'null';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(`[Unserializable export: ${message}]`);
  }
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    terminalIO.error(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
