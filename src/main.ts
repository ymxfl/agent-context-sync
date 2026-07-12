import { pathToFileURL } from 'node:url';

export { addRepository, applyAddRepository } from './commands/add-repo.js';
export { applyInit, initWorkspace } from './commands/init.js';
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

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const command = argv[0] ?? 'help';
  if (command === 'help') {
    io.stdout(JSON.stringify({
      ok: true,
      command,
      data: { commands: ['init', 'join', 'add-repo'] },
    }));
    return 0;
  }
  io.stdout(JSON.stringify({
    ok: false,
    command,
    error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command: ' + command },
  }));
  return 2;
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
