import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KnowledgeEntry, KnowledgeParseContext } from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import { parseKnowledgeEntry } from '../schema/knowledge.js';
import { validateKnowledgeGraph } from './graph.js';
import { parseKnowledgeMarkdown, serializeKnowledge } from './markdown.js';

interface StoredEntry {
  entry: KnowledgeEntry;
  file: string;
}

export interface KnowledgeStoreTransactionAdapter {
  rename(staged: string, target: string): Promise<void>;
}

const nodeKnowledgeStoreTransactionAdapter: KnowledgeStoreTransactionAdapter = {
  rename: (staged, target) => fs.rename(staged, target),
};

interface TransactionOperation {
  target: string;
  staged: string;
  backup: string;
  existed: boolean;
  committed_sha256?: string;
}

interface TransactionJournal {
  schema_version: 1;
  owner_pid: number;
  applying_index: number | null;
  applied_count: number;
  operations: TransactionOperation[];
}

const storeTails = new Map<string, Promise<void>>();

interface WriterLockOwner {
  owner_pid: number;
  token: string;
}

interface WriterReclaimClaim {
  owner_pid: number;
  token: string;
  observed_token: string;
  created_at_ms: number;
}

async function physicalContextRoot(contextRoot: string): Promise<string> {
  const lexicalRoot = path.resolve(contextRoot);
  const rootInfo = await lstatIfExists(lexicalRoot);
  if (rootInfo !== undefined) {
    if (rootInfo.isSymbolicLink()) throw new Error('Context root must not be symbolic');
    if (!rootInfo.isDirectory()) throw new Error('Context root must be a directory');
    return fs.realpath(lexicalRoot);
  }

  const missing: string[] = [];
  let ancestor = lexicalRoot;
  while (true) {
    const info = await lstatIfExists(ancestor);
    if (info !== undefined) {
      if (!info.isDirectory()) throw new Error('Context root ancestor must be a directory');
      return path.join(await fs.realpath(ancestor), ...missing);
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Context root has no existing ancestor');
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

async function withStoreExclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = (storeTails.get(root) ?? Promise.resolve()).catch(() => undefined);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  storeTails.set(root, tail);
  await previous;
  let releaseWriterLock: (() => Promise<void>) | undefined;
  try {
    releaseWriterLock = await acquireWriterLock(root);
    return await action();
  } finally {
    try {
      await releaseWriterLock?.();
    } finally {
      release();
      if (storeTails.get(root) === tail) storeTails.delete(root);
    }
  }
}

async function lstatIfExists(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertContained(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Knowledge path resolves outside its root');
  }
}

function relativeContained(root: string, file: string): string {
  assertContained(root, file);
  return path.relative(root, file);
}

function resolvedJournalPath(root: string, relative: string): string {
  const file = path.resolve(root, relative);
  assertContained(root, file);
  return file;
}

async function assertSafePath(
  root: string,
  file: string,
  leaf: 'regular' | 'directory' | 'any' = 'any',
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  assertContained(root, file);
  const rootInfo = await lstatIfExists(root);
  if (rootInfo === undefined) return undefined;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw corruptJournal();
  if (await fs.realpath(root) !== root) throw corruptJournal();
  const relative = path.relative(root, file);
  let current = root;
  const segments = relative === '' ? [] : relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstatIfExists(current);
    if (info === undefined) return undefined;
    if (info.isSymbolicLink()) throw corruptJournal();
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !info.isDirectory()) throw corruptJournal();
    if (isLeaf && leaf === 'regular' && !info.isFile()) throw corruptJournal();
    if (isLeaf && leaf === 'directory' && !info.isDirectory()) throw corruptJournal();
    const canonical = await fs.realpath(current);
    assertContained(root, canonical);
    if (canonical !== current) throw corruptJournal();
    if (isLeaf) return info;
  }
  if (leaf === 'regular') throw corruptJournal();
  return rootInfo;
}

function transactionDirectory(root: string): string {
  return path.join(root, '.transaction');
}

function journalFile(root: string): string {
  return path.join(transactionDirectory(root), 'journal.json');
}

function corruptJournal(cause?: unknown): Error {
  return new Error('Knowledge transaction journal is corrupt', { cause });
}

function corruptWriterLock(cause?: unknown): Error {
  return new Error('Knowledge writer lock is corrupt or not a non-symbolic directory', { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writerLockDirectory(root: string): string {
  return path.join(root, '.writer-lock');
}

function parseWriterLockOwner(value: unknown): WriterLockOwner {
  if (!isRecord(value)) throw corruptWriterLock();
  const keys = Object.keys(value).sort(compareCodeUnits);
  if (keys.join('\0') !== ['owner_pid', 'token'].join('\0')) throw corruptWriterLock();
  if (
    !Number.isSafeInteger(value.owner_pid)
    || (value.owner_pid as number) <= 0
    || typeof value.token !== 'string'
    || !/^[a-z0-9-]{8,128}$/i.test(value.token)
  ) throw corruptWriterLock();
  return { owner_pid: value.owner_pid as number, token: value.token };
}

async function readWriterLockOwner(lock: string): Promise<WriterLockOwner | undefined> {
  const ownerFile = path.join(lock, 'owner.json');
  const info = await lstatIfExists(ownerFile);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) throw corruptWriterLock();
  try {
    return parseWriterLockOwner(JSON.parse(await fs.readFile(ownerFile, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Knowledge writer lock')) throw error;
    throw corruptWriterLock(error);
  }
}

async function assertWriterLockOwned(lock: string, owner: WriterLockOwner): Promise<void> {
  const info = await lstatIfExists(lock);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw corruptWriterLock();
  }
  const names = (await fs.readdir(lock)).sort(compareCodeUnits);
  if (names.join('\0') !== 'owner.json') throw corruptWriterLock();
  const current = await readWriterLockOwner(lock);
  if (current?.owner_pid !== owner.owner_pid || current.token !== owner.token) {
    throw corruptWriterLock();
  }
}

function parseWriterReclaimClaim(value: unknown): WriterReclaimClaim {
  if (!isRecord(value)) throw corruptWriterLock();
  const keys = Object.keys(value).sort(compareCodeUnits);
  if (keys.join('\0') !== [
    'created_at_ms',
    'observed_token',
    'owner_pid',
    'token',
  ].join('\0')) throw corruptWriterLock();
  if (
    !Number.isSafeInteger(value.owner_pid)
    || (value.owner_pid as number) <= 0
    || typeof value.token !== 'string'
    || !/^[a-z0-9-]{8,128}$/i.test(value.token)
    || typeof value.observed_token !== 'string'
    || !/^[a-z0-9-]{8,128}$/i.test(value.observed_token)
    || !Number.isSafeInteger(value.created_at_ms)
    || (value.created_at_ms as number) <= 0
  ) throw corruptWriterLock();
  return {
    owner_pid: value.owner_pid as number,
    token: value.token,
    observed_token: value.observed_token,
    created_at_ms: value.created_at_ms as number,
  };
}

async function readWriterReclaimClaim(file: string): Promise<WriterReclaimClaim | undefined> {
  const info = await lstatIfExists(file);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) throw corruptWriterLock();
  try {
    return parseWriterReclaimClaim(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Knowledge writer lock')) throw error;
    throw corruptWriterLock(error);
  }
}

async function publishWriterReclaimClaim(
  lock: string,
  claim: WriterReclaimClaim,
): Promise<boolean> {
  const claimFile = path.join(lock, 'reclaim.json');
  const temporary = path.join(lock, `.reclaim-${claim.token}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(claim)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporary, claimFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    await syncDirectory(lock);
    return true;
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

function writerLockQuarantine(root: string, token: string): string {
  return path.join(root, `.writer-lock-quarantine-${token}`);
}

function writerLockReleaseQuarantine(root: string, token: string): string {
  return path.join(root, `.writer-lock-release-quarantine-${token}`);
}

function isAllowedWriterQuarantineChild(name: string): boolean {
  return name === 'owner.json'
    || name === 'reclaim.json'
    || /^\.reclaim-[a-z0-9-]{8,128}\.tmp$/i.test(name)
    || /^\.reclaim-stale-[a-z0-9-]{8,128}\.json$/i.test(name);
}

async function assertWriterQuarantineComponents(quarantine: string): Promise<void> {
  for (const child of await fs.readdir(quarantine)) {
    if (!isAllowedWriterQuarantineChild(child)) throw corruptWriterLock();
    const childInfo = await lstatIfExists(path.join(quarantine, child));
    if (childInfo === undefined) continue;
    if (childInfo.isSymbolicLink() || !childInfo.isFile()) throw corruptWriterLock();
  }
}

async function cleanupWriterLockQuarantines(root: string): Promise<void> {
  for (const name of await fs.readdir(root)) {
    const match = /^\.writer-lock-(release-)?quarantine-([a-z0-9-]{8,128})$/i.exec(name);
    if (match === null) continue;
    const quarantine = path.join(root, name);
    const info = await lstatIfExists(quarantine);
    if (info === undefined) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) throw corruptWriterLock();
    await assertWriterQuarantineComponents(quarantine);
    const owner = await readWriterLockOwner(quarantine);
    const claim = await readWriterReclaimClaim(path.join(quarantine, 'reclaim.json'));
    if (owner !== undefined && claim !== undefined && claim.observed_token !== owner.token) {
      throw corruptWriterLock();
    }
    if (claim !== undefined && isProcessAlive(claim.owner_pid)) continue;
    if (match[1] !== undefined && owner !== undefined && isProcessAlive(owner.owner_pid)) continue;
    await fs.rm(quarantine, { recursive: true, force: true });
  }
}

async function quarantineOwnerlessWriterLock(root: string, lock: string): Promise<void> {
  await assertWriterQuarantineComponents(lock);
  const quarantine = writerLockReleaseQuarantine(root, randomUUID());
  try {
    await fs.rename(lock, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
}

async function releaseWriterLock(lock: string, owner: WriterLockOwner): Promise<void> {
  await assertWriterLockOwned(lock, owner);
  const quarantine = writerLockReleaseQuarantine(path.dirname(lock), randomUUID());
  await fs.rename(lock, quarantine);
  const quarantinedOwner = await readWriterLockOwner(quarantine);
  if (quarantinedOwner === undefined) return;
  if (quarantinedOwner.owner_pid !== owner.owner_pid || quarantinedOwner.token !== owner.token) {
    throw corruptWriterLock();
  }
  await fs.rm(quarantine, { recursive: true, force: true });
}

async function claimStaleWriterLock(lock: string, observed: WriterLockOwner): Promise<boolean> {
  const claimFile = path.join(lock, 'reclaim.json');
  const claim: WriterReclaimClaim = {
    owner_pid: process.pid,
    token: randomUUID(),
    observed_token: observed.token,
    created_at_ms: Date.now(),
  };
  if (!await publishWriterReclaimClaim(lock, claim)) {
    const existing = await readWriterReclaimClaim(claimFile);
    if (existing === undefined) return false;
    if (existing.observed_token !== observed.token) throw corruptWriterLock();
    if (isProcessAlive(existing.owner_pid)) return false;

    const quarantine = path.join(lock, `.reclaim-stale-${randomUUID()}.json`);
    try {
      await fs.rename(claimFile, quarantine);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw renameError;
    }
    const moved = await readWriterReclaimClaim(quarantine);
    await fs.rm(quarantine, { force: true });
    if (moved?.token !== existing.token) return false;
    return false;
  }

  const ownedClaim = await readWriterReclaimClaim(claimFile);
  if (ownedClaim?.token !== claim.token || ownedClaim.observed_token !== observed.token) return false;
  const current = await readWriterLockOwner(lock);
  if (current?.owner_pid !== observed.owner_pid || current.token !== observed.token) {
    throw corruptWriterLock();
  }
  const quarantine = writerLockQuarantine(path.dirname(lock), claim.token);
  await fs.rename(lock, quarantine);
  const quarantinedOwner = await readWriterLockOwner(quarantine);
  const quarantinedClaim = await readWriterReclaimClaim(path.join(quarantine, 'reclaim.json'));
  if (
    quarantinedOwner?.owner_pid !== observed.owner_pid
    || quarantinedOwner.token !== observed.token
    || quarantinedClaim?.token !== claim.token
    || quarantinedClaim.observed_token !== observed.token
  ) throw corruptWriterLock();
  await fs.rm(quarantine, { recursive: true });
  return true;
}

async function acquireWriterLock(root: string): Promise<() => Promise<void>> {
  const rootInfo = await lstatIfExists(root);
  if (rootInfo === undefined) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await assertSafePath(root, root, 'directory');
  await cleanupWriterLockQuarantines(root);
  const lock = writerLockDirectory(root);
  const owner = { owner_pid: process.pid, token: randomUUID() };
  while (true) {
    const candidate = path.join(root, `.writer-lock-candidate-${owner.token}`);
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      await fs.writeFile(
        path.join(candidate, 'owner.json'),
        `${JSON.stringify(owner)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await fs.rename(candidate, lock);
      return async () => {
        await releaseWriterLock(lock, owner);
      };
    } catch (error) {
      await fs.rm(candidate, { recursive: true, force: true });
      if (!new Set(['EEXIST', 'ENOTDIR', 'ENOTEMPTY']).has(
        (error as NodeJS.ErrnoException).code ?? '',
      )) {
        throw error;
      }
    }

    const lockInfo = await lstatIfExists(lock);
    if (lockInfo === undefined) continue;
    if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) throw corruptWriterLock();
    const current = await readWriterLockOwner(lock);
    if (current === undefined) {
      await quarantineOwnerlessWriterLock(root, lock);
      continue;
    }
    if (isProcessAlive(current.owner_pid)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    if (!await claimStaleWriterLock(lock, current)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function assertJournalRelativePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    throw corruptJournal();
  }
  const resolved = resolvedJournalPath(root, value);
  if (path.relative(root, resolved) !== value) throw corruptJournal();
  return value;
}

function parseTransactionJournal(value: unknown, root: string): TransactionJournal {
  if (!isRecord(value)) throw corruptJournal();
  const keys = Object.keys(value).sort(compareCodeUnits);
  if (keys.join('\0') !== [
    'applied_count',
    'applying_index',
    'operations',
    'owner_pid',
    'schema_version',
  ].join('\0')) throw corruptJournal();
  if (
    value.schema_version !== 1
    || !Number.isSafeInteger(value.owner_pid)
    || (value.owner_pid as number) <= 0
    || !Number.isSafeInteger(value.applied_count)
    || (value.applied_count as number) < 0
    || !Array.isArray(value.operations)
  ) throw corruptJournal();

  const appliedCount = value.applied_count as number;
  const applyingIndex = value.applying_index;
  if (
    applyingIndex !== null
    && (!Number.isSafeInteger(applyingIndex) || (applyingIndex as number) < 0)
  ) throw corruptJournal();
  if (
    appliedCount > value.operations.length
    || (applyingIndex !== null
      && (applyingIndex !== appliedCount || applyingIndex >= value.operations.length))
  ) throw corruptJournal();

  const targets = new Set<string>();
  const operations = value.operations.map((candidate, index): TransactionOperation => {
    if (!isRecord(candidate)) throw corruptJournal();
    const operationKeys = Object.keys(candidate).sort(compareCodeUnits);
    if (
      operationKeys.join('\0') !== ['backup', 'existed', 'staged', 'target'].join('\0')
      && operationKeys.join('\0') !== [
        'backup',
        'committed_sha256',
        'existed',
        'staged',
        'target',
      ].join('\0')
    ) {
      throw corruptJournal();
    }
    if (typeof candidate.existed !== 'boolean') throw corruptJournal();
    if (
      candidate.committed_sha256 !== undefined
      && (typeof candidate.committed_sha256 !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(candidate.committed_sha256))
    ) throw corruptJournal();
    const target = assertJournalRelativePath(root, candidate.target);
    const staged = assertJournalRelativePath(root, candidate.staged);
    const backup = assertJournalRelativePath(root, candidate.backup);
    if (
      !target.endsWith('.md')
      || (!target.startsWith(`workspace${path.sep}`)
        && !target.startsWith(`repositories${path.sep}`))
      || staged !== path.join('.transaction', 'staged', `${index}.stage`)
      || backup !== path.join('.transaction', 'backups', `${index}.backup`)
      || targets.has(target)
    ) throw corruptJournal();
    targets.add(target);
    return {
      target,
      staged,
      backup,
      existed: candidate.existed,
      ...(candidate.committed_sha256 === undefined
        ? {}
        : { committed_sha256: candidate.committed_sha256 }),
    };
  });

  return {
    schema_version: 1,
    owner_pid: value.owner_pid as number,
    applying_index: applyingIndex as number | null,
    applied_count: appliedCount,
    operations,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readJournal(root: string): Promise<TransactionJournal | undefined> {
  const file = journalFile(root);
  const bytes = await readRegularFileNoFollowIfExists(root, file);
  if (bytes === undefined) return undefined;
  try {
    return parseTransactionJournal(JSON.parse(bytes.toString('utf8')), root);
  } catch (error) {
    if (error instanceof Error && error.message === 'Knowledge transaction journal is corrupt') {
      throw error;
    }
    throw corruptJournal(error);
  }
}

function expectedTarget(entry: Pick<KnowledgeEntry, 'id' | 'scope'>): string {
  return entry.scope === 'workspace'
    ? path.join('workspace', `${entry.id}.md`)
    : path.join('repositories', entry.scope.slice('repository:'.length), `${entry.id}.md`);
}

function sha256(contents: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

async function readRegularFileNoFollow(root: string, file: string): Promise<Buffer> {
  const bytes = await readRegularFileNoFollowIfExists(root, file);
  if (bytes === undefined) throw corruptJournal();
  return bytes;
}

async function readRegularFileNoFollowIfExists(
  root: string,
  file: string,
): Promise<Buffer | undefined> {
  const expected = await assertSafePath(root, file, 'regular');
  if (expected === undefined) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw corruptJournal();
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof Error && error.message === 'Knowledge transaction journal is corrupt') {
      throw error;
    }
    throw corruptJournal(error);
  } finally {
    await handle?.close();
  }
}

async function atomicWriteBytes(file: string, contents: Uint8Array): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let renamed = false;
  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    if (!renamed) await fs.rm(temporary, { force: true });
  }
}

async function validateTransactionTree(root: string): Promise<void> {
  const directory = transactionDirectory(root);
  async function walk(current: string): Promise<void> {
    await assertSafePath(root, current, 'directory');
    for (const name of await fs.readdir(current)) {
      const child = path.join(current, name);
      const info = await assertSafePath(root, child);
      if (info?.isDirectory()) await walk(child);
      else if (info === undefined || !info.isFile()) throw corruptJournal();
    }
  }
  await walk(directory);
}

async function validateJournalPaths(
  root: string,
  journal: TransactionJournal,
  context?: KnowledgeParseContext,
): Promise<void> {
  await validateTransactionTree(root);
  for (const operation of journal.operations) {
    const artifacts = [
      { file: resolvedJournalPath(root, operation.target), required: false },
      { file: resolvedJournalPath(root, operation.staged), required: false },
      { file: resolvedJournalPath(root, operation.backup), required: operation.existed },
    ];
    let metadataCount = 0;
    for (const artifact of artifacts) {
      const bytes = await readRegularFileNoFollowIfExists(root, artifact.file);
      if (bytes === undefined) {
        if (artifact.required) throw corruptJournal();
        continue;
      }
      let parsed: KnowledgeEntry;
      try {
        parsed = parseKnowledgeMarkdown(bytes.toString('utf8'), context);
      } catch (error) {
        throw corruptJournal(error);
      }
      if (expectedTarget(parsed) !== operation.target) throw corruptJournal();
      metadataCount += 1;
    }
    if (metadataCount === 0) throw corruptJournal();
  }
}

async function validateCommittedTargets(
  root: string,
  journal: TransactionJournal,
  context?: KnowledgeParseContext,
): Promise<void> {
  for (const operation of journal.operations) {
    const target = resolvedJournalPath(root, operation.target);
    const targetInfo = await assertSafePath(root, target, 'regular');
    if (targetInfo === undefined) throw corruptJournal();
    let targetBytes: Buffer;
    let parsed: KnowledgeEntry;
    try {
      targetBytes = await readRegularFileNoFollow(root, target);
      parsed = parseKnowledgeMarkdown(targetBytes.toString('utf8'), context);
    } catch (error) {
      throw corruptJournal(error);
    }
    if (expectedTarget(parsed) !== operation.target) throw corruptJournal();

    let expectedHash = operation.committed_sha256;
    if (expectedHash === undefined) {
      const staged = resolvedJournalPath(root, operation.staged);
      const stagedInfo = await assertSafePath(root, staged, 'regular');
      if (stagedInfo === undefined) throw corruptJournal();
      expectedHash = sha256(await readRegularFileNoFollow(root, staged));
    }
    if (sha256(targetBytes) !== expectedHash) throw corruptJournal();
  }
}

async function writeJournal(root: string, journal: TransactionJournal): Promise<void> {
  await atomicWriteFile(journalFile(root), `${JSON.stringify(journal)}\n`);
}

async function rollbackJournal(
  root: string,
  journal: TransactionJournal,
  context?: KnowledgeParseContext,
): Promise<void> {
  await validateJournalPaths(root, journal, context);
  for (const operation of [...journal.operations].reverse()) {
    const target = resolvedJournalPath(root, operation.target);
    await assertSafePath(root, target, 'regular');
    if (operation.existed) {
      const backup = resolvedJournalPath(root, operation.backup);
      const contents = await readRegularFileNoFollow(root, backup);
      await atomicWriteBytes(target, contents);
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

async function recoverIncompleteTransaction(
  root: string,
  context?: KnowledgeParseContext,
): Promise<void> {
  const directory = transactionDirectory(root);
  while (true) {
    const directoryInfo = await lstatIfExists(directory);
    if (directoryInfo === undefined) return;
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error('Knowledge transaction path must be a non-symbolic directory');
    }
    const journal = await readJournal(root);
    if (journal === undefined) {
      if (Date.now() - Number(directoryInfo.mtimeMs) < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      await fs.rm(directory, { recursive: true, force: true });
      return;
    }
    if (journal.owner_pid !== process.pid && isProcessAlive(journal.owner_pid)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    await validateJournalPaths(root, journal, context);
    if (
      journal.applying_index === null
      && journal.applied_count === journal.operations.length
    ) {
      await validateCommittedTargets(root, journal, context);
      await fs.rm(directory, { recursive: true, force: true });
      return;
    }
    await rollbackJournal(root, journal, context);
    await fs.rm(directory, { recursive: true, force: true });
    return;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (!new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']).has(code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function markdownFiles(root: string): Promise<string[]> {
  const info = await lstatIfExists(root);
  if (info === undefined) return [];
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Knowledge root must be a non-symbolic directory');
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`Knowledge path must not be symbolic: ${file}`);
      if (child.isDirectory()) await walk(file);
      else if (child.isFile() && child.name.endsWith('.md')) files.push(file);
    }
  }
  await walk(root);
  return files;
}

function graphError(entries: KnowledgeEntry[]): Error | undefined {
  const issues = validateKnowledgeGraph(entries);
  if (issues.length === 0) return undefined;
  const first = issues[0] as (typeof issues)[number];
  return new Error(`Invalid Knowledge graph (${first.code}): ${first.message}`);
}

export class KnowledgeStore {
  readonly root: string;
  private readonly contextRoot: string;

  constructor(
    contextRoot: string,
    private readonly context?: KnowledgeParseContext,
    private readonly transactionAdapter: KnowledgeStoreTransactionAdapter =
      nodeKnowledgeStoreTransactionAdapter,
  ) {
    this.contextRoot = path.resolve(contextRoot);
    this.root = path.resolve(this.contextRoot, 'knowledge');
    assertContained(this.contextRoot, this.root);
  }

  private async physicalRoot(): Promise<string> {
    return path.join(await physicalContextRoot(this.contextRoot), 'knowledge');
  }

  private fileFor(root: string, entry: Pick<KnowledgeEntry, 'id' | 'scope'>): string {
    const file = path.resolve(root, expectedTarget(entry));
    assertContained(root, file);
    return file;
  }

  private async storedEntriesUnlocked(root: string): Promise<StoredEntry[]> {
    const stored: StoredEntry[] = [];
    for (const file of await markdownFiles(root)) {
      const entry = parseKnowledgeMarkdown(await fs.readFile(file, 'utf8'), this.context);
      if (file !== this.fileFor(root, entry)) {
        throw new Error(`Knowledge ${entry.id} is not stored at its ID-derived path`);
      }
      stored.push({ entry, file });
    }
    stored.sort((left, right) => compareCodeUnits(left.entry.id, right.entry.id)
      || compareCodeUnits(left.file, right.file));
    const error = graphError(stored.map(({ entry }) => entry));
    if (error) throw error;
    return stored;
  }

  async list(): Promise<KnowledgeEntry[]> {
    const root = await this.physicalRoot();
    return withStoreExclusive(root, async () => {
      await recoverIncompleteTransaction(root, this.context);
      return (await this.storedEntriesUnlocked(root)).map(({ entry }) => entry);
    });
  }

  async get(id: string): Promise<KnowledgeEntry | undefined> {
    const root = await this.physicalRoot();
    return withStoreExclusive(root, async () => {
      await recoverIncompleteTransaction(root, this.context);
      return (await this.storedEntriesUnlocked(root)).find(({ entry }) => entry.id === id)?.entry;
    });
  }

  async put(entry: KnowledgeEntry): Promise<void> {
    const root = await this.physicalRoot();
    return withStoreExclusive(root, async () => {
      await recoverIncompleteTransaction(root, this.context);
      await this.putUnlocked(root, entry);
    });
  }

  private async commitChanges(
    root: string,
    changes: ReadonlyArray<{ file: string; contents: string }>,
  ): Promise<void> {
    if (changes.length === 0) return;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await assertSafePath(root, root, 'directory');
    const directory = transactionDirectory(root);
    while (true) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await recoverIncompleteTransaction(root, this.context);
      }
    }
    const journal: TransactionJournal = {
      schema_version: 1,
      owner_pid: process.pid,
      applying_index: null,
      applied_count: 0,
      operations: [],
    };
    try {
      await writeJournal(root, journal);
      const stagedDirectory = path.join(directory, 'staged');
      const backupDirectory = path.join(directory, 'backups');
      await fs.mkdir(stagedDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      for (const [index, change] of changes.entries()) {
        const staged = path.join(stagedDirectory, `${index}.stage`);
        const backup = path.join(backupDirectory, `${index}.backup`);
        const previous = await lstatIfExists(change.file);
        if (previous !== undefined && (previous.isSymbolicLink() || !previous.isFile())) {
          throw new Error(`Knowledge target is not a regular file: ${change.file}`);
        }
        await fs.mkdir(path.dirname(change.file), { recursive: true, mode: 0o700 });
        await atomicWriteFile(staged, change.contents);
        if (previous !== undefined) {
          await atomicWriteBytes(backup, await readRegularFileNoFollow(root, change.file));
        }
        journal.operations.push({
          target: relativeContained(root, change.file),
          staged: relativeContained(root, staged),
          backup: relativeContained(root, backup),
          existed: previous !== undefined,
          committed_sha256: sha256(change.contents),
        });
      }
      await writeJournal(root, journal);

      await validateJournalPaths(root, journal, this.context);

      for (const [index, operation] of journal.operations.entries()) {
        journal.applying_index = index;
        await writeJournal(root, journal);
        await validateJournalPaths(root, journal, this.context);
        await this.transactionAdapter.rename(
          resolvedJournalPath(root, operation.staged),
          resolvedJournalPath(root, operation.target),
        );
        await syncDirectory(path.dirname(resolvedJournalPath(root, operation.target)));
        journal.applied_count = index + 1;
        journal.applying_index = null;
        await writeJournal(root, journal);
      }
      await validateCommittedTargets(root, journal, this.context);
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'Knowledge transaction journal is corrupt'
        && journal.applying_index === null
        && journal.applied_count === journal.operations.length
      ) throw error;
      try {
        if (journal.operations.length > 0) await rollbackJournal(root, journal, this.context);
        await fs.rm(directory, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Knowledge transaction and rollback failed');
      }
      throw error;
    }
  }

  private async putUnlocked(root: string, entry: KnowledgeEntry): Promise<void> {
    const validated = parseKnowledgeEntry(entry, this.context);
    const stored = await this.storedEntriesUnlocked(root);
    const previous = stored.find((item) => item.entry.id === validated.id);
    const target = this.fileFor(root, validated);
    if (previous !== undefined && previous.file !== target) {
      throw new Error('Knowledge scope cannot move an existing ID to a different path');
    }

    const byId = new Map(stored.map((item) => [item.entry.id, item.entry]));
    byId.set(validated.id, validated);
    for (const conflictId of validated.conflicts_with) {
      const conflict = byId.get(conflictId);
      if (conflict !== undefined && !conflict.conflicts_with.includes(validated.id)) {
        byId.set(conflictId, {
          ...conflict,
          conflicts_with: [...conflict.conflicts_with, validated.id],
        });
      }
    }
    for (const [id, current] of byId) {
      if (id === validated.id || validated.conflicts_with.includes(id)) continue;
      if (current.conflicts_with.includes(validated.id)) {
        byId.set(id, {
          ...current,
          conflicts_with: current.conflicts_with.filter((targetId) => targetId !== validated.id),
        });
      }
    }

    const entries = [...byId.values()];
    const error = graphError(entries);
    if (error) throw error;
    entries.sort((left, right) => compareCodeUnits(left.id, right.id));
    const changes: Array<{ file: string; contents: string }> = [];
    for (const current of entries) {
      const old = stored.find((item) => item.entry.id === current.id)?.entry;
      const contents = serializeKnowledge(current);
      if (old === undefined || serializeKnowledge(old) !== contents) {
        changes.push({ file: this.fileFor(root, current), contents });
      }
    }
    await this.commitChanges(root, changes);
  }
}
