export interface TraceEvent {
  timestamp: string;
  pid: number;
  operation: string;
  path: string;
}

export interface TraceProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  unavailableReason(): string;
  start(command: string, args: readonly string[]): Promise<void>;
  stop(): Promise<TraceEvent[]>;
}

/** Default caps for experimental tracing runs. */
export const TRACE_MAX_RUNTIME_MS = 30_000;
export const TRACE_MAX_EVENTS = 1_000;

const PATH_OPERATIONS = new Set([
  'open',
  'openat',
  'stat',
  'stat64',
  'lstat',
  'lstat64',
  'fstatat',
  'newfstatat',
  'readlink',
  'readlinkat',
  'access',
  'faccessat',
]);

export function isPathOperation(operation: string): boolean {
  const normalized = operation.toLowerCase().replace(/_$/, '');
  return PATH_OPERATIONS.has(normalized) || PATH_OPERATIONS.has(operation);
}

export function capTraceEvents(events: readonly TraceEvent[]): TraceEvent[] {
  return events.slice(0, TRACE_MAX_EVENTS);
}

export async function resolveTraceProvider(
  platform: NodeJS.Platform = process.platform,
): Promise<TraceProvider | undefined> {
  if (platform === 'darwin') {
    const { MacOsFsUsageProvider } = await import('./macos-fs-usage.js');
    return new MacOsFsUsageProvider();
  }
  if (platform === 'linux') {
    const { LinuxStraceProvider } = await import('./linux-strace.js');
    return new LinuxStraceProvider();
  }
  return undefined;
}
