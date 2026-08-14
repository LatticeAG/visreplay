import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Write UTF-8 text by creating a temp file in the destination directory, then
 * renaming it into place. If rename fails with EXDEV, copy then unlink the
 * temp file. A failed write must not truncate an existing destination.
 */
export async function writeTextAtomically(
  filePath: string,
  contents: string,
  mode: number = 0o600
): Promise<void> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new TypeError('A destination file path is required');
  }
  if (typeof contents !== 'string') {
    throw new TypeError('Atomic write contents must be a string');
  }

  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);

  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', mode });
    await replaceDestination(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function replaceDestination(temporaryPath: string, filePath: string): Promise<void> {
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (!isExdev(error)) {
      throw error;
    }

    try {
      await fs.copyFile(temporaryPath, filePath);
    } catch {
      throw error;
    }

    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function isExdev(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'EXDEV';
}
