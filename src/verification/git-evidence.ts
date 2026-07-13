import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommitRecord {
  readonly commit: string;
  readonly subject: string;
  readonly author: string;
  readonly authored_at: string;
}

export interface GitBlameLine {
  readonly commit: string;
  readonly path: string;
  readonly line: number;
}

export interface BoundedGitOptions {
  readonly cwd: string;
  readonly maxCommits: number;
  readonly timeoutMs: number;
  readonly paths?: readonly string[];
}

export interface BoundedGitResult {
  readonly commits: GitCommitRecord[];
  readonly blame: GitBlameLine[];
  readonly timedOut: boolean;
}

function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  return candidate.killed === true
    || candidate.signal === 'SIGTERM'
    || candidate.code === 'ETIMEDOUT';
}

async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; timedOut: boolean }> {
  if (timeoutMs <= 0) return { stdout: '', timedOut: true };
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout: String(stdout), timedOut: false };
  } catch (error) {
    if (isTimeoutError(error)) return { stdout: '', timedOut: true };
    const err = error as { stdout?: string; code?: number };
    // Non-zero git exits (e.g. no blame yet) yield empty evidence rather than failing collection.
    if (typeof err.stdout === 'string') return { stdout: err.stdout, timedOut: false };
    return { stdout: '', timedOut: false };
  }
}

function parseLog(stdout: string, maxCommits: number): GitCommitRecord[] {
  const commits: GitCommitRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const [commit, subject = '', author = '', authored_at = ''] = line.split('\t');
    if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) continue;
    commits.push({ commit, subject, author, authored_at });
    if (commits.length >= maxCommits) break;
  }
  return commits;
}

/**
 * Collects a bounded git log (and optional path-scoped blame) without throwing on timeouts.
 */
export async function collectGitEvidence(options: BoundedGitOptions): Promise<BoundedGitResult> {
  const commits: GitCommitRecord[] = [];
  const blame: GitBlameLine[] = [];
  let remaining = options.timeoutMs;
  let timedOut = false;

  const started = Date.now();
  const logArgs = [
    'log',
    '-n',
    String(Math.max(0, options.maxCommits)),
    '--pretty=format:%H%x09%s%x09%an%x09%aI',
  ];
  if (options.paths !== undefined && options.paths.length > 0) {
    logArgs.push('--', ...options.paths.slice(0, 20));
  }

  const logResult = await runGit(options.cwd, logArgs, remaining);
  timedOut = timedOut || logResult.timedOut;
  commits.push(...parseLog(logResult.stdout, options.maxCommits));
  remaining = Math.max(0, options.timeoutMs - (Date.now() - started));

  if (!timedOut && remaining > 0 && options.paths !== undefined) {
    for (const relativePath of options.paths.slice(0, 5)) {
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const blameResult = await runGit(
        options.cwd,
        ['blame', '-l', '-L', '1,20', '--', relativePath],
        remaining,
      );
      timedOut = timedOut || blameResult.timedOut;
      remaining = Math.max(0, options.timeoutMs - (Date.now() - started));
      if (blameResult.timedOut) break;

      for (const line of blameResult.stdout.split('\n')) {
        const match = /^(?:[\^])?([0-9a-f]{40})\s+(?:\S+\s+)?(\d+)/.exec(line);
        if (match === null) continue;
        const commit = match[1];
        const lineNumber = Number(match[2]);
        if (commit === undefined || !Number.isFinite(lineNumber)) continue;
        blame.push({ commit, path: relativePath, line: lineNumber });
        if (!commits.some((item) => item.commit === commit) && commits.length < options.maxCommits) {
          commits.push({
            commit,
            subject: '',
            author: '',
            authored_at: '',
          });
        }
      }
    }
  }

  return { commits, blame, timedOut };
}
