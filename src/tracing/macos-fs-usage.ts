import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
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

const FS_USAGE_LINE =
  /^(?<timestamp>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<operation>[A-Za-z0-9_]+)\b(?<rest>.*)$/;

const PATH_IN_REST = /(?:^|\s)(\/(?:[^\s]+))\s+(?:\d+\.\d+)\s+(\S+)\s*$/;
const PID_FROM_PROCESS = /\.(\d+)\s*$/;

/**
 * Parse fs_usage fixture/text into path metadata events.
 * Pure function — does not read files from disk beyond the provided text.
 */
export function parseFsUsage(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const match = FS_USAGE_LINE.exec(line);
    if (match?.groups === undefined) continue;
    const operation = match.groups.operation ?? '';
    if (!isPathOperation(operation)) continue;
    const rest = match.groups.rest ?? '';
    const pathMatch = PATH_IN_REST.exec(rest);
    if (pathMatch === null) continue;
    const filePath = pathMatch[1] as string;
    const processToken = pathMatch[2] as string;
    const pidMatch = PID_FROM_PROCESS.exec(processToken);
    const pid = pidMatch === null ? 0 : Number(pidMatch[1]);
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

export class MacOsFsUsageProvider implements TraceProvider {
  readonly name = 'macos-fs-usage';

  private reason = 'macOS fs_usage provider has not been checked yet.';
  private child: ChildProcess | undefined;
  private target: ChildProcess | undefined;
  private outputPath: string | undefined;
  private runtimeTimer: NodeJS.Timeout | undefined;
  private collecting = false;

  unavailableReason(): string {
    return this.reason;
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      this.reason = 'fs_usage is unavailable: not running on macOS.';
      return false;
    }
    try {
      await fs.access('/usr/bin/fs_usage');
    } catch {
      this.reason = 'fs_usage is unavailable: /usr/bin/fs_usage is not installed.';
      return false;
    }
    // Authorization cannot be proven without a privileged probe; treat presence as
    // provisionally available and surface authorization failures at start().
    this.reason = 'fs_usage is available on macOS (may require authorization at runtime).';
    return true;
  }

  async start(command: string, args: readonly string[]): Promise<void> {
    if (this.collecting) {
      throw new Error('fs_usage tracing is already running');
    }
    if (!(await this.isAvailable())) {
      throw new Error(this.reason);
    }

    this.outputPath = path.join(
      tmpdir(),
      `acs-fs-usage-${process.pid}-${Date.now()}.log`,
    );
    const out = createWriteStream(this.outputPath);
    await new Promise<void>((resolve, reject) => {
      out.once('ready', () => resolve());
      out.once('error', reject);
    });

    this.target = spawn(command, [...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const targetPid = this.target.pid;
    if (targetPid === undefined) {
      out.close();
      throw new Error('Failed to launch traced command');
    }

    this.child = spawn('fs_usage', ['-w', '-f', 'pathname', String(targetPid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.pipe(out);
    this.child.stderr?.resume();
    this.collecting = true;

    this.runtimeTimer = setTimeout(() => {
      this.child?.kill('SIGTERM');
      this.target?.kill('SIGTERM');
    }, TRACE_MAX_RUNTIME_MS);
  }

  async stop(): Promise<TraceEvent[]> {
    if (!this.collecting || this.outputPath === undefined) {
      throw new Error('fs_usage tracing is not running');
    }
    if (this.runtimeTimer !== undefined) {
      clearTimeout(this.runtimeTimer);
      this.runtimeTimer = undefined;
    }

    const target = this.target;
    const child = this.child;
    this.target = undefined;
    this.child = undefined;
    this.collecting = false;

    if (target !== undefined && target.exitCode === null && !target.killed) {
      await new Promise<void>((resolve) => {
        target.once('exit', () => resolve());
        target.kill('SIGTERM');
        setTimeout(() => {
          if (target.exitCode === null) target.kill('SIGKILL');
        }, 1_000);
      });
    }

    child?.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child === undefined || child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 1_000);
    });

    const text = await fs.readFile(this.outputPath, 'utf8').catch(() => '');
    await fs.rm(this.outputPath, { force: true }).catch(() => undefined);
    this.outputPath = undefined;
    return capTraceEvents(parseFsUsage(text));
  }
}
