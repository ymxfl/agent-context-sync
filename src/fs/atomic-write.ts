import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export interface AtomicWriteFileHandle {
  writeFile(data: string, options: { encoding: BufferEncoding }): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicWriteAdapter {
  mkdir(
    directory: string,
    options: { recursive: true; mode: number },
  ): Promise<string | undefined>;
  chmod(file: string, mode: number): Promise<void>;
  open(file: string, flags: string, mode?: number): Promise<AtomicWriteFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

export const nodeAtomicWriteAdapter: AtomicWriteAdapter = {
  mkdir: (directory, options) => fs.mkdir(directory, options),
  chmod: (file, mode) => fs.chmod(file, mode),
  open: (file, flags, mode) => fs.open(file, flags, mode),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: (file) => fs.unlink(file),
};

const unsupportedDirectorySyncErrors = new Set([
  'EACCES',
  'EBADF',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EPERM',
]);

function isUnsupportedDirectorySync(error: unknown): boolean {
  return unsupportedDirectorySyncErrors.has(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

async function syncParentDirectory(
  directory: string,
  adapter: AtomicWriteAdapter,
): Promise<void> {
  let handle: AtomicWriteFileHandle;
  try {
    handle = await adapter.open(directory, 'r');
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }

  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

async function removeTemporaryFile(
  temporaryPath: string,
  adapter: AtomicWriteAdapter,
): Promise<void> {
  try {
    await adapter.unlink(temporaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function atomicWriteFile(
  file: string,
  contents: string,
  adapter: AtomicWriteAdapter = nodeAtomicWriteAdapter,
): Promise<void> {
  const directory = path.dirname(file);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );

  const createdDirectory = await adapter.mkdir(
    directory,
    { recursive: true, mode: 0o700 },
  );
  if (createdDirectory) await adapter.chmod(directory, 0o700);

  let handle: AtomicWriteFileHandle | undefined;
  let renamed = false;
  try {
    handle = await adapter.open(temporaryPath, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await adapter.rename(temporaryPath, file);
    renamed = true;
    await syncParentDirectory(directory, adapter);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the error that prevented the atomic write.
      }
    }
    if (!renamed) {
      try {
        await removeTemporaryFile(temporaryPath, adapter);
      } catch {
        // Preserve the error that prevented the atomic write.
      }
    }
    throw error;
  }
}
