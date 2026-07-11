import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || String(error));
  }
}

export async function fixtureGit(path: string, args: readonly string[]): Promise<string> {
  return runGit(path, args);
}

export async function initFixtureRepository(path: string, remote?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await runGit(path, ['init', '--initial-branch=main']);
  await runGit(path, ['config', 'user.name', 'Agent Context Sync Tests']);
  await runGit(path, ['config', 'user.email', 'tests@agent-context-sync.invalid']);
  await runGit(path, ['commit', '--allow-empty', '-m', 'Initial commit']);
  if (remote !== undefined) {
    await runGit(path, ['remote', 'add', 'origin', remote]);
  }
}

export async function createBareRemote(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await runGit(path, ['init', '--bare', '--initial-branch=main']);
  return path;
}
