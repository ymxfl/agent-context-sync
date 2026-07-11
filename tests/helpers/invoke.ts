import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(
  new URL('../../skill/agent-context-sync/scripts/acs.mjs', import.meta.url),
);

export interface InvokeResult {
  exitCode: number;
  json: any;
  stderr: string;
}

export async function invoke(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({
          exitCode: code ?? 1,
          json: JSON.parse(stdout),
          stderr,
        });
      } catch (error) {
        reject(new Error(`Failed to parse command output as JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}
