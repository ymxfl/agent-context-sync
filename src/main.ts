import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AgentName } from './adapters/adapter.js';
import { addRepository, applyAddRepository } from './commands/add-repo.js';
import { doctor } from './commands/doctor.js';
import { applyInit, initWorkspace } from './commands/init.js';
import { inspect } from './commands/inspect.js';
import { applyJoin, joinWorkspace } from './commands/join.js';
import type { WorkspacePreview } from './workspace/context-repository.js';

export { addRepository, applyAddRepository } from './commands/add-repo.js';
export { doctor } from './commands/doctor.js';
export { applyInit, initWorkspace } from './commands/init.js';
export { inspect } from './commands/inspect.js';
export { applyJoin, joinWorkspace } from './commands/join.js';

export interface CommandIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface AppError {
  code: string;
  message: string;
}

export interface JsonEnvelope {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: AppError;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string[]>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name.length === 0) throw new Error('Invalid empty option');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option --${name} requires a value`);
    }
    const existing = options.get(name) ?? [];
    existing.push(value);
    options.set(name, existing);
    index += 1;
  }
  return { positionals, options };
}

function one(args: ParsedArguments, name: string): string {
  const values = args.options.get(name);
  if (values?.length !== 1) throw new Error(`Option --${name} is required exactly once`);
  return values[0] as string;
}

function many(args: ParsedArguments, name: string): string[] {
  return args.options.get(name) ?? [];
}

function assertOptions(args: ParsedArguments, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of args.options.keys()) {
    if (!allowedSet.has(name)) throw new Error(`Unknown option --${name}`);
  }
}

function nonNegativeInteger(value: string, name: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Option --${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Option --${name} must be a safe integer`);
  return parsed;
}

function parsePreview(value: string): WorkspacePreview {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Preview JSON must be an object');
  }
  return parsed as WorkspacePreview;
}

function homePaths(): { home: string; homeDir: string } {
  const homeDir = path.resolve(process.env.HOME ?? homedir());
  return {
    home: path.resolve(process.env.AGENT_CONTEXT_SYNC_HOME ?? path.join(homeDir, '.agent-context-sync')),
    homeDir,
  };
}

async function dispatch(command: string, argv: readonly string[]): Promise<unknown> {
  if (command === 'help') {
    if (argv.length > 0) throw new Error('help accepts no arguments');
    return { commands: ['init', 'join', 'add-repo', 'inspect', 'doctor'] };
  }
  const args = parseArguments(argv);
  const { home, homeDir } = homePaths();
  if (command === 'init' || command === 'join' || command === 'add-repo') {
    const phase = args.positionals[0];
    if (args.positionals.length !== 1 || (phase !== 'preview' && phase !== 'apply')) {
      throw new Error(`${command} requires exactly one phase: preview or apply`);
    }
    if (phase === 'apply') {
      assertOptions(args, ['preview-json']);
      const preview = parsePreview(one(args, 'preview-json'));
      if (command === 'init') return { result: await applyInit(preview) };
      if (command === 'join') return { result: await applyJoin(preview) };
      return { result: await applyAddRepository(preview) };
    }
    if (command === 'init') {
      assertOptions(args, ['name', 'context-remote', 'scan-root', 'max-depth']);
      return { preview: await initWorkspace({
        name: one(args, 'name'),
        contextRemote: one(args, 'context-remote'),
        scanRoot: one(args, 'scan-root'),
        maxDepth: nonNegativeInteger(one(args, 'max-depth'), 'max-depth'),
        home,
      }) };
    }
    if (command === 'join') {
      assertOptions(args, ['context-remote', 'scan-root', 'max-depth']);
      const scanRoots = many(args, 'scan-root');
      if (scanRoots.length === 0) throw new Error('Option --scan-root is required');
      return { preview: await joinWorkspace({
        contextRemote: one(args, 'context-remote'),
        scanRoots,
        maxDepth: nonNegativeInteger(one(args, 'max-depth'), 'max-depth'),
        home,
      }) };
    }
    assertOptions(args, ['workspace', 'repository']);
    return { preview: await addRepository({
      workspaceId: one(args, 'workspace'),
      repositoryPath: one(args, 'repository'),
      home,
    }) };
  }
  if (args.positionals.length !== 0) throw new Error(`${command} accepts no positional arguments`);
  if (command === 'inspect') {
    assertOptions(args, ['workspace', 'agent', 'repository']);
    const agent = one(args, 'agent');
    if (agent !== 'claude-code' && agent !== 'codex') {
      throw new Error('Option --agent must be claude-code or codex');
    }
    const repositories = many(args, 'repository');
    return { reports: await inspect({
      workspaceId: one(args, 'workspace'),
      agent: agent as AgentName,
      home,
      homeDir,
      ...(repositories.length === 0 ? {} : { repositories }),
    }) };
  }
  if (command === 'doctor') {
    assertOptions(args, ['workspace']);
    return doctor({ workspaceId: one(args, 'workspace'), home, homeDir });
  }
  throw Object.assign(new Error(`Unknown command: ${command}`), { code: 'UNKNOWN_COMMAND' });
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const command = argv[0] ?? 'help';
  try {
    const data = await dispatch(command, argv.slice(1));
    io.stdout(JSON.stringify({ ok: true, command, data }));
    return 0;
  } catch (error) {
    const candidate = error as { code?: unknown };
    const code = typeof candidate.code === 'string'
      ? candidate.code
      : 'INVALID_ARGUMENT';
    io.stdout(JSON.stringify({
      ok: false,
      command,
      error: {
        code,
        message: code === 'UNKNOWN_COMMAND'
          ? `Unknown command: ${command}`
          : 'The command could not be completed with the supplied input.',
      },
    }));
    return 2;
  }
}

const isProcessEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isProcessEntry) {
  const io: CommandIO = {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  };
  process.exitCode = await run(process.argv.slice(2), io);
}
