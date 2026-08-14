import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RenameFn = (oldPath: PathLike, newPath: PathLike) => Promise<void>;
type CopyFn = (source: PathLike, destination: PathLike) => Promise<void>;

const fsMocks = vi.hoisted(() => ({
  rename: vi.fn<RenameFn>(),
  copyFile: vi.fn<CopyFn>(),
  actualRename: undefined as RenameFn | undefined,
  actualCopyFile: undefined as CopyFn | undefined
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.actualRename = actual.rename;
  fsMocks.actualCopyFile = actual.copyFile;
  fsMocks.rename.mockImplementation((oldPath, newPath) => actual.rename(oldPath, newPath));
  fsMocks.copyFile.mockImplementation((source, destination) => actual.copyFile(source, destination));
  return {
    ...actual,
    rename: fsMocks.rename,
    copyFile: fsMocks.copyFile
  };
});

import { writeTextAtomically } from './atomic-write';

const temporaryDirectories: string[] = [];

beforeEach(() => {
  fsMocks.rename.mockReset();
  fsMocks.copyFile.mockReset();
  fsMocks.rename.mockImplementation((oldPath, newPath) => fsMocks.actualRename!(oldPath, newPath));
  fsMocks.copyFile.mockImplementation((source, destination) => fsMocks.actualCopyFile!(source, destination));
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('writeTextAtomically', () => {
  it('creates parent directories and writes UTF-8 contents with mode 0o600', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'nested', 'export.json');

    await writeTextAtomically(filePath, '{"ok":true}\n');

    expect(await readFile(filePath, 'utf8')).toBe('{"ok":true}\n');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('retries EXDEV from rename by copying the temp file into place', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'cross-device.json');
    fsMocks.rename.mockRejectedValueOnce(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    );

    await writeTextAtomically(filePath, 'copied-contents\n');

    expect(fsMocks.rename).toHaveBeenCalled();
    expect(fsMocks.copyFile).toHaveBeenCalled();
    expect(await readFile(filePath, 'utf8')).toBe('copied-contents\n');
  });

  it('throws the original EXDEV error when copyFile also fails and leaves the destination intact', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'keep-me.json');
    await writeFile(filePath, 'original\n', { encoding: 'utf8', mode: 0o600 });
    const exdev = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    fsMocks.rename.mockRejectedValue(exdev);
    fsMocks.copyFile.mockRejectedValue(new Error('copy failed'));

    await expect(writeTextAtomically(filePath, 'replacement\n')).rejects.toThrow('cross-device link');
    expect(await readFile(filePath, 'utf8')).toBe('original\n');
  });

  it('does not truncate an existing destination when rename fails for a non-EXDEV reason', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, 'existing.json');
    await writeFile(filePath, 'keep\n', { encoding: 'utf8', mode: 0o600 });
    fsMocks.rename.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    await expect(writeTextAtomically(filePath, 'new\n')).rejects.toThrow('busy');
    expect(await readFile(filePath, 'utf8')).toBe('keep\n');
  });

  it('rejects an empty destination path', async () => {
    await expect(writeTextAtomically('   ', 'x')).rejects.toThrow('A destination file path is required');
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'visreplay-atomic-'));
  temporaryDirectories.push(directory);
  return directory;
}
