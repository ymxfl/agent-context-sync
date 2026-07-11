import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
}

export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(
          Object.assign(error, {
            stdout,
            stderr,
          }),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
