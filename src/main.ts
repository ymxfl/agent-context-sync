import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as fs from 'node:fs/promises';

import type { AgentName } from './adapters/adapter.js';
import { sanitizedAppErrorDetails } from './domain/errors.js';
import { addRepository, applyAddRepository } from './commands/add-repo.js';
import { applyRendered, previewApply } from './commands/apply.js';
import { prepareCapture, previewCapture, applyCapture } from './commands/capture.js';
import { prepareCheck, previewCheck, applyCheck } from './commands/check.js';
import { doctor } from './commands/doctor.js';
import { applyInit, initWorkspace } from './commands/init.js';
import { inspect } from './commands/inspect.js';
import { applyJoin, joinWorkspace } from './commands/join.js';
import { syncPrepare } from './commands/sync.js';

export { addRepository, applyAddRepository } from './commands/add-repo.js';
export { applyRendered, previewApply } from './commands/apply.js';
export { prepareCapture, previewCapture, applyCapture } from './commands/capture.js';
export { prepareCheck, previewCheck, applyCheck } from './commands/check.js';
export { doctor } from './commands/doctor.js';
export { applyInit, initWorkspace } from './commands/init.js';
export { inspect } from './commands/inspect.js';
export { applyJoin, joinWorkspace } from './commands/join.js';
export { syncPrepare } from './commands/sync.js';

export interface CommandIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface AppError {
  code: string;
  message: string;
  details?: unknown;
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

export function parseRepositoryBindings(values: readonly string[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('Option --binding must use repo_id=path');
    }
    const repositoryId = value.slice(0, separator);
    const repositoryPath = value.slice(separator + 1);
    if (Object.hasOwn(bindings, repositoryId)) {
      throw new Error(`Duplicate --binding for ${repositoryId}`);
    }
    Object.defineProperty(bindings, repositoryId, {
      value: repositoryPath,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return bindings;
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

function homePaths(): { home: string; homeDir: string } {
  const homeDir = path.resolve(process.env.HOME ?? homedir());
  return {
    home: path.resolve(process.env.AGENT_CONTEXT_SYNC_HOME ?? path.join(homeDir, '.agent-context-sync')),
    homeDir,
  };
}

function parseBooleanOption(args: ParsedArguments, name: string): boolean {
  if (!args.options.has(name)) return false;
  const value = one(args, name).trim().toLowerCase();
  if (value === 'true' || value === 'yes' || value === '1') return true;
  if (value === 'false' || value === 'no' || value === '0') return false;
  throw new Error(`Option --${name} must be true or false`);
}

async function readProposalArgument(value: string): Promise<unknown> {
  try {
    const contents = await fs.readFile(value, 'utf8');
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new Error('Option --proposal file must contain valid JSON');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Option --proposal must be a JSON string or a path to a JSON file');
  }
}

async function dispatch(command: string, argv: readonly string[]): Promise<unknown> {
  if (command === 'help') {
    if (argv.length > 0) throw new Error('help accepts no arguments');
    return {
      commands: ['init', 'join', 'add-repo', 'inspect', 'doctor', 'capture', 'check', 'apply', 'sync'],
    };
  }
  const args = parseArguments(argv);
  const { home, homeDir } = homePaths();
  if (command === 'check') {
    const phase = args.positionals[0];
    if (args.positionals.length !== 1 || (phase !== 'prepare' && phase !== 'preview' && phase !== 'apply')) {
      throw new Error('check requires exactly one phase: prepare, preview, or apply');
    }
    if (phase === 'apply') {
      assertOptions(args, ['preview-id']);
      return { result: await applyCheck(one(args, 'preview-id'), home) };
    }
    if (phase === 'prepare') {
      assertOptions(args, ['workspace', 'repository', 'knowledge-id', 'scope']);
      const repositories = many(args, 'repository');
      const knowledgeIds = many(args, 'knowledge-id');
      const scopeValue = args.options.has('scope') ? one(args, 'scope') : undefined;
      if (
        scopeValue !== undefined
        && scopeValue !== 'workspace'
        && !scopeValue.startsWith('repository:')
      ) {
        throw new Error('Option --scope must be workspace or repository:<repo_id>');
      }
      return { packets: await prepareCheck({
        workspaceId: one(args, 'workspace'),
        home,
        ...(repositories.length === 0 ? {} : { repositories }),
        ...(knowledgeIds.length === 0 ? {} : { knowledgeIds }),
        ...(scopeValue === undefined ? {} : { scope: scopeValue as 'workspace' | `repository:${string}` }),
      }) };
    }
    assertOptions(args, ['packet-id', 'proposal']);
    const packetIds = many(args, 'packet-id');
    if (packetIds.length === 0) throw new Error('Option --packet-id is required');
    const proposal = await readProposalArgument(one(args, 'proposal'));
    return { preview: await previewCheck(packetIds, proposal, { home }) };
  }
  if (command === 'capture' || command === 'sync') {
    const phase = args.positionals[0];
    if (command === 'sync') {
      if (args.positionals.length !== 1 || phase !== 'prepare') {
        throw new Error('sync requires exactly one phase: prepare');
      }
      assertOptions(args, ['workspace', 'agent', 'repository', 'include-personal', 'cwd']);
      const agent = one(args, 'agent');
      if (agent !== 'claude-code' && agent !== 'codex') {
        throw new Error('Option --agent must be claude-code or codex');
      }
      const repositories = many(args, 'repository');
      return { packet: await syncPrepare({
        workspaceId: one(args, 'workspace'),
        agent: agent as AgentName,
        home,
        homeDir,
        ...(repositories.length === 0 ? {} : { repositories }),
        ...(args.options.has('include-personal')
          ? { includePersonal: parseBooleanOption(args, 'include-personal') }
          : {}),
        ...(args.options.has('cwd') ? { cwd: one(args, 'cwd') } : {}),
      }) };
    }
    if (args.positionals.length !== 1 || (phase !== 'prepare' && phase !== 'preview' && phase !== 'apply')) {
      throw new Error('capture requires exactly one phase: prepare, preview, or apply');
    }
    if (phase === 'apply') {
      assertOptions(args, ['preview-id']);
      return { result: await applyCapture(one(args, 'preview-id'), home) };
    }
    if (phase === 'prepare') {
      assertOptions(args, ['workspace', 'agent', 'repository', 'include-personal', 'cwd']);
      const agent = one(args, 'agent');
      if (agent !== 'claude-code' && agent !== 'codex') {
        throw new Error('Option --agent must be claude-code or codex');
      }
      const repositories = many(args, 'repository');
      return { packet: await prepareCapture({
        workspaceId: one(args, 'workspace'),
        agent: agent as AgentName,
        home,
        homeDir,
        ...(repositories.length === 0 ? {} : { repositories }),
        ...(args.options.has('include-personal')
          ? { includePersonal: parseBooleanOption(args, 'include-personal') }
          : {}),
        ...(args.options.has('cwd') ? { cwd: one(args, 'cwd') } : {}),
      }) };
    }
    assertOptions(args, ['packet-id', 'proposal']);
    const proposal = await readProposalArgument(one(args, 'proposal'));
    return { preview: await previewCapture(one(args, 'packet-id'), proposal, { home }) };
  }
  if (command === 'apply') {
    const phase = args.positionals[0];
    if (args.positionals.length !== 1 || (phase !== 'preview' && phase !== 'apply')) {
      throw new Error('apply requires exactly one phase: preview or apply');
    }
    if (phase === 'apply') {
      assertOptions(args, ['preview-id']);
      return { result: await applyRendered(one(args, 'preview-id'), home) };
    }
    assertOptions(args, ['workspace', 'agent', 'repository']);
    const agentValues = many(args, 'agent');
    const agents = (agentValues.length === 0 ? ['claude-code', 'codex'] : agentValues);
    for (const agent of agents) {
      if (agent !== 'claude-code' && agent !== 'codex') {
        throw new Error('Option --agent must be claude-code or codex');
      }
    }
    const repositories = many(args, 'repository');
    return { preview: await previewApply({
      workspaceId: one(args, 'workspace'),
      agents: agents as AgentName[],
      home,
      ...(repositories.length === 0 ? {} : { repositories }),
    }) };
  }
  if (command === 'init' || command === 'join' || command === 'add-repo') {
    const phase = args.positionals[0];
    if (args.positionals.length !== 1 || (phase !== 'preview' && phase !== 'apply')) {
      throw new Error(`${command} requires exactly one phase: preview or apply`);
    }
    if (phase === 'apply') {
      assertOptions(args, ['preview-id']);
      const previewId = one(args, 'preview-id');
      if (command === 'init') return { result: await applyInit(previewId, home) };
      if (command === 'join') return { result: await applyJoin(previewId, home) };
      return { result: await applyAddRepository(previewId, home) };
    }
    if (command === 'init') {
      assertOptions(args, ['name', 'context-remote', 'scan-root', 'max-depth', 'binding']);
      return { preview: await initWorkspace({
        name: one(args, 'name'),
        contextRemote: one(args, 'context-remote'),
        scanRoot: one(args, 'scan-root'),
        maxDepth: nonNegativeInteger(one(args, 'max-depth'), 'max-depth'),
        home,
        bindings: parseRepositoryBindings(many(args, 'binding')),
      }) };
    }
    if (command === 'join') {
      assertOptions(args, ['context-remote', 'scan-root', 'max-depth', 'binding']);
      const scanRoots = many(args, 'scan-root');
      if (scanRoots.length === 0) throw new Error('Option --scan-root is required');
      return { preview: await joinWorkspace({
        contextRemote: one(args, 'context-remote'),
        scanRoots,
        maxDepth: nonNegativeInteger(one(args, 'max-depth'), 'max-depth'),
        home,
        bindings: parseRepositoryBindings(many(args, 'binding')),
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
    assertOptions(args, ['workspace', 'agent', 'repository', 'cwd']);
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
      ...(args.options.has('cwd') ? { cwd: one(args, 'cwd') } : {}),
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
    const candidate = error as { code?: unknown; details?: unknown };
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
        ...(typeof candidate.code === 'string'
          && sanitizedAppErrorDetails(candidate as { code: string; message: string; details?: unknown }) !== undefined
          ? { details: sanitizedAppErrorDetails(candidate as { code: string; message: string; details?: unknown }) }
          : {}),
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
