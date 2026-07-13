import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TRACE_MAX_EVENTS,
  TRACE_MAX_RUNTIME_MS,
  capTraceEvents,
  isPathOperation,
  type TraceEvent,
  type TraceProvider,
} from './provider.js';

const STRACE_LINE =
  /^(?:\[pid\s+(?<bracketPid>\d+)\]\s+)?(?:(?<pid>\d+)\s+)?(?<timestamp>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<operation>[a-z0-9_]+)\((?<args>.*)\)\s*=/i;

const QUOTED_PATH = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/;

/**
 * Parse strace fixture/text into path metadata events.
 * Pure function — does not read files from disk beyond the provided text.
 */
export function parseStrace(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = STRACE_LINE.exec(line);
    if (match?.groups === undefined) continue;
    const operation = match.groups.operation ?? '';
    if (!isPathOperation(operation)) continue;
    const args = match.groups.args ?? '';
    const pathMatch = QUOTED_PATH.exec(args);
    if (pathMatch === null) continue;
    const filePath = (pathMatch[1] ?? pathMatch[2] ?? '').replace(/\\"/g, '"').replace(/\\'/g, "'");
    if (!filePath.startsWith('/')) continue;
    const pidToken = match.groups.pid ?? match.groups.bracketPid ?? '0';
    const pid = Number(pidToken);
    events.push({
      timestamp: match.groups.timestamp as string,
      pid: Number.isSafeInteger(pid) ? pid : 0,
      operation,
      path: filePath,
    });
    if (events.length >= TRACE_MAX_EVENTS) break;
  }
  return events;
}

async function commandExists(binary: string): Promise<boolean> {
  const searchPath = process.env.PATH ?? '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir.length === 0) continue;
    try {
      await fs.access(path.join(dir, binary));
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

async function ptraceAllowed(): Promise<{ ok: boolean; detail: string }> {
  try {
    const scope = (await fs.readFile('/proc/sys/kernel/yama/ptrace_scope', 'utf8')).trim();
    // 0 = classic ptrace permissions; 1 = restricted to dumpable parent (still ok for strace of child)
    if (scope === '0' || scope === '1') {
      return { ok: true, detail: `ptrace_scope=${scope}` };
    }
    return {
      ok: false,
      detail: `ptrace is restricted (ptrace_scope=${scope}); strace cannot attach`,
    };
  } catch {
    // No Yama — assume classic permissions.
    return { ok: true, detail: 'ptrace_scope unavailable; assuming classic ptrace permissions' };
  }
}

export class LinuxStraceProvider implements TraceProvider {
  readonly name = 'linux-strace';

  private reason = 'Linux strace provider has not been checked yet.';
  private child: ChildProcess | undefined;
  private outputPath: string | undefined;
  private runtimeTimer: NodeJS.Timeout | undefined;
  private collecting = false;

  unavailableReason(): string {
    return this.reason;
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') {
      this.reason = 'strace is unavailable: not running on Linux.';
      return false;
    }
    if (!(await commandExists('strace'))) {
      this.reason = 'strace is unavailable: strace is not installed.';
      return false;
    }
    const ptrace = await ptraceAllowed();
    if (!ptrace.ok) {
      this.reason = `strace is unavailable: ${ptrace.detail}.`;
      return false;
    }
    this.reason = `strace is available on Linux (${ptrace.detail}).`;
    return true;
  }

  async start(command: string, args: readonly string[]): Promise<void> {
    if (this.collecting) {
      throw new Error('strace tracing is already running');
    }
    if (!(await this.isAvailable())) {
      throw new Error(this.reason);
    }

    this.outputPath = path.join(
      tmpdir(),
      `acs-strace-${process.pid}-${Date.now()}.log`,
    );

    // Trace the launched process tree; capture only path-bearing syscalls.
    this.child = spawn('strace', [
      '-f',
      '-tt',
      '-e',
      'trace=open,openat,stat,lstat,fstatat,newfstatat,statx,readlink,readlinkat,access,faccessat',
      '-o',
      this.outputPath,
      command,
      ...args,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.stderr?.resume();
    this.collecting = true;

    this.runtimeTimer = setTimeout(() => {
      this.child?.kill('SIGTERM');
    }, TRACE_MAX_RUNTIME_MS);
  }

  async stop(): Promise<TraceEvent[]> {
    if (!this.collecting || this.outputPath === undefined) {
      throw new Error('strace tracing is not running');
    }
    if (this.runtimeTimer !== undefined) {
      clearTimeout(this.runtimeTimer);
      this.runtimeTimer = undefined;
    }

    const child = this.child;
    const outputPath = this.outputPath;
    this.child = undefined;
    this.outputPath = undefined;
    this.collecting = false;

    if (child !== undefined) {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const forceKill = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 500);
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(forceKill);
          resolve();
        });
      });
    }

    const text = await fs.readFile(outputPath, 'utf8').catch(() => '');
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    return capTraceEvents(parseStrace(text));
  }
}
