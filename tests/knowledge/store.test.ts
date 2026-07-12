import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import {
  parseKnowledgeMarkdown,
  serializeKnowledge,
} from '../../src/knowledge/markdown.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';

const now = '2026-07-11T10:00:00Z';
const hash = `sha256:${'a'.repeat(64)}`;
const ids = {
  a: 'kn_01J00000000000000000000000',
  b: 'kn_01J00000000000000000000001',
};

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id: ids.a,
    kind: 'architecture-decision',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: ['src/z/**', 'src/a/**'], agents: ['codex', 'claude-code'] },
    source: {
      agent: 'claude-code',
      source_type: 'auto-memory',
      locator: 'claude-auto-memory/MEMORY.md',
      content_hash: hash,
      observed_at: now,
    },
    confidence: 0.92,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: 'Use server-side sessions, not JWTs.',
    reason: 'The server must be able to revoke sessions.',
    ...overrides,
  };
}

describe('canonical Knowledge Markdown', () => {
  it('round trips deterministically with sorted arrays, LF endings, and one final newline', () => {
    const knowledge = entry();
    const first = serializeKnowledge(knowledge);
    const second = serializeKnowledge(knowledge);

    expect(first).toBe(second);
    expect(parseKnowledgeMarkdown(first)).toEqual({
      ...knowledge,
      applies_to: {
        paths: ['src/a/**', 'src/z/**'],
        agents: ['claude-code', 'codex'],
      },
    });
    expect(first).not.toContain('\r');
    expect(first).toMatch(/[^\n]\n$/);
    expect(first).not.toMatch(/\n\n$/);
    expect(first).not.toContain('/Users/alice');
  });

  it('rejects local absolute path leakage before serialization', () => {
    expect(() => serializeKnowledge(entry({
      source: { ...entry().source, locator: '/Users/alice/.claude/memory.md' },
    }))).toThrow(/locator/i);
  });

  it('round trips literal Reason headings inside multiline statement and reason text', () => {
    const knowledge = entry({
      statement: 'First statement line.\n\n## Reason\n\nThis heading is statement data.',
      reason: 'First reason line.\n\n## Reason\n\nThis heading is reason data.',
    });

    expect(parseKnowledgeMarkdown(serializeKnowledge(knowledge))).toEqual({
      ...knowledge,
      applies_to: {
        paths: ['src/a/**', 'src/z/**'],
        agents: ['claude-code', 'codex'],
      },
    });
  });

  it.each([
    ['macOS statement', { statement: 'Read /Users/alice/private.md.' }],
    ['Linux reason', { reason: 'Read /home/alice/private.md.' }],
    ['Windows statement', { statement: String.raw`Read C:\Users\alice\private.md.` }],
    ['UNC reason', { reason: String.raw`Read \\server\share\private.md.` }],
    ['file URL Agent name', { source: { ...entry().source, agent: 'file:///Users/alice' } }],
    ['macOS applies-to Agent', {
      applies_to: { ...entry().applies_to, agents: ['/Users/alice/.codex'] },
    }],
  ] satisfies Array<[string, Partial<KnowledgeEntry>]>) (
    'rejects private absolute path leakage from %s',
    (_name, overrides) => expect(() => serializeKnowledge(entry(overrides))).toThrow(/private local path/i),
  );

  it.each([
    '/Users/alice/project/**',
    '/home/alice/project/**',
    String.raw`C:\Users\alice\project\**`,
    String.raw`\\server\share\project\**`,
    'file:///Users/alice/project/**',
    '../private/**',
    'src/../private/**',
    './src/**',
  ])('rejects non-repository-relative applies_to path %j', (candidate) => {
    expect(() => serializeKnowledge(entry({
      applies_to: { ...entry().applies_to, paths: [candidate] },
    }))).toThrow(/paths/i);
  });

  it('allows repository-relative POSIX globs and explicitly identified HTTP routes', () => {
    expect(() => serializeKnowledge(entry({
      applies_to: { paths: ['packages/*/src/**', 'src/api/*.ts'], agents: ['codex'] },
      statement: 'Serve GET /api/users and URI: /v1/health.',
      reason: 'These are API routes, not local paths.',
    }))).not.toThrow();
  });

  it.each([
    '/',
    '/tmp/agent-context-sync/private.md',
    '/private/tmp/agent-context-sync/private.md',
    '/var/db/agent-context-sync/private.md',
    '/Volumes/Secret/private.md',
    '/opt/acme/private.md',
    '/etc/passwd',
    '/api/users',
    String.raw`D:\work\private.md`,
    String.raw`\\server\share\private.md`,
    '//server/share/private.md',
    'file:///tmp/private.md',
    'FILE://server/share/private.md',
  ])('rejects filesystem syntax in a serialized string: %j', (candidate) => {
    expect(() => serializeKnowledge(entry({
      statement: `Read ${candidate} before continuing.`,
    }))).toThrow(/private local path/i);
  });

  it('rejects a private path injected only into the human display body', () => {
    const serialized = serializeKnowledge(entry());
    const tampered = serialized.replace(
      '\n---\n\nUse server-side sessions, not JWTs.',
      '\n---\n\nRead /Users/alice/private.md.',
    );
    expect(() => parseKnowledgeMarkdown(tampered)).toThrow(/private local path/i);
  });
});

describe('KnowledgeStore', () => {
  let root: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-knowledge-'));
    store = new KnowledgeStore(root, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    });
  });

  it('uses the entry ID and scope to derive contained canonical paths', async () => {
    await store.put(entry());
    await store.put(entry({
      id: ids.b,
      scope: 'repository:github.com/acme/api',
    }));

    expect(await fs.readFile(
      path.join(root, 'knowledge/workspace', `${ids.a}.md`),
      'utf8',
    )).toBe(serializeKnowledge(entry()));
    expect(await fs.readFile(
      path.join(root, 'knowledge/repositories/github.com/acme/api', `${ids.b}.md`),
      'utf8',
    )).toBe(serializeKnowledge(entry({
      id: ids.b,
      scope: 'repository:github.com/acme/api',
    })));
  });

  it('keeps archived entries at the same path and never physically deletes them', async () => {
    const file = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    await store.put(entry());
    await store.put(entry({ status: 'archived' }));

    expect(parseKnowledgeMarkdown(await fs.readFile(file, 'utf8')).status).toBe('archived');
    expect(await store.get(ids.a)).toMatchObject({ status: 'archived' });
    expect((await store.list()).map((item) => item.id)).toEqual([ids.a]);
  });

  it('normalizes conflicts_with symmetrically across the whole store', async () => {
    await store.put(entry());
    await store.put(entry({ id: ids.b }));
    await store.put(entry({ conflicts_with: [ids.b] }));

    expect((await store.get(ids.a))?.conflicts_with).toEqual([ids.b]);
    expect((await store.get(ids.b))?.conflicts_with).toEqual([ids.a]);
  });

  it('rejects missing relation targets without changing stored bytes', async () => {
    await store.put(entry());
    const file = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    const before = await fs.readFile(file, 'utf8');

    await expect(store.put(entry({ supersedes: [ids.b] }))).rejects.toThrow(/missing/i);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('detects duplicate IDs anywhere in the store', async () => {
    await store.put(entry());
    const duplicate = path.join(root, 'knowledge/repositories/github.com/acme/api', `${ids.a}.md`);
    await fs.mkdir(path.dirname(duplicate), { recursive: true });
    await fs.writeFile(duplicate, serializeKnowledge(entry({
      scope: 'repository:github.com/acme/api',
    })));

    await expect(store.list()).rejects.toThrow(/duplicate/i);
    await expect(store.get(ids.a)).rejects.toThrow(/duplicate/i);
  });

  it('rolls back every reciprocal write when the first final rename reports failure', async () => {
    await store.put(entry());
    await store.put(entry({ id: ids.b }));
    const files = [
      path.join(root, 'knowledge/workspace', `${ids.a}.md`),
      path.join(root, 'knowledge/workspace', `${ids.b}.md`),
    ];
    const before = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
    let injected = false;
    const failing = new KnowledgeStore(root, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    }, {
      async rename(staged, target) {
        await fs.rename(staged, target);
        if (!injected) {
          injected = true;
          throw new Error('injected failure after first rename');
        }
      },
    });

    await expect(failing.put(entry({ conflicts_with: [ids.b] })))
      .rejects.toThrow(/injected failure/i);
    expect(await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).toEqual(before);
    expect((await failing.list()).map((item) => [item.id, item.conflicts_with])).toEqual([
      [ids.a, []],
      [ids.b, []],
    ]);
    expect((await fs.readdir(path.join(root, 'knowledge'))).sort()).toEqual(['workspace']);

    await failing.put(entry({ conflicts_with: [ids.b] }));
    expect((await failing.get(ids.a))?.conflicts_with).toEqual([ids.b]);
    expect((await failing.get(ids.b))?.conflicts_with).toEqual([ids.a]);
  });

  it('keeps fully applied bytes when recovery finds a committed journal', async () => {
    await store.put(entry());
    const target = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    const transaction = path.join(root, 'knowledge/.transaction');
    const backup = path.join(transaction, 'backups/0.backup');
    const staged = path.join(transaction, 'staged/0.stage');
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.copyFile(target, backup);
    await fs.writeFile(target, serializeKnowledge(entry({ status: 'archived' })));
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999_999,
      applying_index: null,
      applied_count: 1,
      operations: [{
        target: path.relative(path.join(root, 'knowledge'), target),
        staged: path.relative(path.join(root, 'knowledge'), staged),
        backup: path.relative(path.join(root, 'knowledge'), backup),
        existed: true,
      }],
    })}\n`);

    expect((await store.get(ids.a))?.status).toBe('archived');
    await expect(fs.access(transaction)).rejects.toThrow();
    expect((await store.get(ids.a))?.status).toBe('archived');
  });

  it('rolls back an applying journal before exposing entries and recovery is idempotent', async () => {
    await store.put(entry());
    const target = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    const transaction = path.join(root, 'knowledge/.transaction');
    const backup = path.join(transaction, 'backups/0.backup');
    const staged = path.join(transaction, 'staged/0.stage');
    const original = await fs.readFile(target, 'utf8');
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(backup, original);
    await fs.writeFile(target, serializeKnowledge(entry({ status: 'archived' })));
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999_999,
      applying_index: 0,
      applied_count: 0,
      operations: [{
        target: path.relative(path.join(root, 'knowledge'), target),
        staged: path.relative(path.join(root, 'knowledge'), staged),
        backup: path.relative(path.join(root, 'knowledge'), backup),
        existed: true,
      }],
    })}\n`);

    expect((await store.list()).map((item) => item.status)).toEqual(['active']);
    expect(await fs.readFile(target, 'utf8')).toBe(original);
    await expect(fs.access(transaction)).rejects.toThrow();
    expect((await store.list()).map((item) => item.status)).toEqual(['active']);
  });

  it('rejects a corrupt journal repeatedly without changing stored bytes', async () => {
    await store.put(entry());
    const target = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    const before = await fs.readFile(target, 'utf8');
    const transaction = path.join(root, 'knowledge/.transaction');
    await fs.mkdir(transaction);
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 2,
      owner_pid: 999_999_999,
      applying_index: null,
      applied_count: 0,
      operations: [],
    })}\n`);

    await expect(store.get(ids.a)).rejects.toThrow(/transaction journal.*corrupt/i);
    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(transaction, 'journal.json'), 'utf8')).toContain('"schema_version":2');
  });

  it('waits for an in-process transaction before a reader exposes graph state', async () => {
    await store.put(entry());
    await store.put(entry({ id: ids.b }));
    let releaseRename = (): void => undefined;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    let signalRenameStarted = (): void => undefined;
    const renameStarted = new Promise<void>((resolve) => { signalRenameStarted = resolve; });
    let first = true;
    const writer = new KnowledgeStore(root, undefined, {
      async rename(staged, target) {
        if (first) {
          first = false;
          signalRenameStarted();
          await renameGate;
        }
        await fs.rename(staged, target);
      },
    });

    const write = writer.put(entry({ conflicts_with: [ids.b] }));
    await renameStarted;
    let readerResolved = false;
    const read = store.list().then((entries) => {
      readerResolved = true;
      return entries;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readerResolved).toBe(false);

    releaseRename();
    await write;
    expect((await read).map((item) => [item.id, item.conflicts_with])).toEqual([
      [ids.a, [ids.b]],
      [ids.b, [ids.a]],
    ]);
  });

  it('uses one physical lock for a live writer and a reader reached through an alias parent', async () => {
    await store.put(entry());
    await store.put(entry({ id: ids.b }));
    const aliasBase = await fs.mkdtemp(path.join(tmpdir(), 'acs-knowledge-alias-'));
    const aliasParent = path.join(aliasBase, 'contexts');
    await fs.symlink(path.dirname(root), aliasParent);
    const aliasRoot = path.join(aliasParent, path.basename(root));
    const aliasReader = new KnowledgeStore(aliasRoot, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    });
    let releaseRename = (): void => undefined;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    let signalRenameStarted = (): void => undefined;
    const renameStarted = new Promise<void>((resolve) => { signalRenameStarted = resolve; });
    let first = true;
    const writer = new KnowledgeStore(root, undefined, {
      async rename(staged, target) {
        if (first) {
          first = false;
          signalRenameStarted();
          await renameGate;
        }
        await fs.rename(staged, target);
      },
    });

    const write = writer.put(entry({ conflicts_with: [ids.b] }));
    await renameStarted;
    let readerResolved = false;
    const read = aliasReader.list().then((entries) => {
      readerResolved = true;
      return entries;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readerResolved).toBe(false);

    releaseRename();
    await write;
    expect((await read).map((item) => [item.id, item.conflicts_with])).toEqual([
      [ids.a, [ids.b]],
      [ids.b, [ids.a]],
    ]);
  });

  it('rejects a directly symlinked Context root', async () => {
    const aliasBase = await fs.mkdtemp(path.join(tmpdir(), 'acs-context-root-alias-'));
    const aliasRoot = path.join(aliasBase, 'context');
    await fs.symlink(root, aliasRoot);

    const aliasStore = new KnowledgeStore(aliasRoot);
    await expect(aliasStore.list()).rejects.toThrow(/Context root.*symbolic/i);
  });

  it('rejects an applying journal whose target ancestor escapes through a symlink', async () => {
    await store.put(entry());
    const knowledge = path.join(root, 'knowledge');
    const transaction = path.join(knowledge, '.transaction');
    const original = await fs.readFile(path.join(knowledge, 'workspace', `${ids.a}.md`), 'utf8');
    await fs.rm(path.join(knowledge, 'workspace'), { recursive: true });
    const external = await fs.mkdtemp(path.join(tmpdir(), 'acs-external-knowledge-'));
    const sentinel = path.join(external, `${ids.a}.md`);
    await fs.writeFile(sentinel, 'outside sentinel');
    await fs.symlink(external, path.join(knowledge, 'workspace'));
    await fs.mkdir(path.join(transaction, 'backups'), { recursive: true });
    await fs.mkdir(path.join(transaction, 'staged'), { recursive: true });
    await fs.writeFile(path.join(transaction, 'backups/0.backup'), original);
    await fs.writeFile(path.join(transaction, 'staged/0.stage'), serializeKnowledge(entry({
      status: 'archived',
    })));
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999_999,
      applying_index: 0,
      applied_count: 0,
      operations: [{
        target: path.join('workspace', `${ids.a}.md`),
        staged: path.join('.transaction', 'staged', '0.stage'),
        backup: path.join('.transaction', 'backups', '0.backup'),
        existed: true,
      }],
    })}\n`);

    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
    expect(await fs.readFile(path.join(transaction, 'journal.json'), 'utf8')).toContain(ids.a);
  });

  it('rejects a committed journal with a symlinked target and preserves recovery evidence', async () => {
    await store.put(entry());
    const knowledge = path.join(root, 'knowledge');
    const target = path.join(knowledge, 'workspace', `${ids.a}.md`);
    const transaction = path.join(knowledge, '.transaction');
    const external = await fs.mkdtemp(path.join(tmpdir(), 'acs-external-knowledge-'));
    const sentinel = path.join(external, 'sentinel.md');
    await fs.writeFile(sentinel, 'outside sentinel');
    await fs.rm(target);
    await fs.symlink(sentinel, target);
    await fs.mkdir(path.join(transaction, 'backups'), { recursive: true });
    await fs.mkdir(path.join(transaction, 'staged'), { recursive: true });
    await fs.writeFile(path.join(transaction, 'backups/0.backup'), serializeKnowledge(entry()));
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999_999,
      applying_index: null,
      applied_count: 1,
      operations: [{
        target: path.join('workspace', `${ids.a}.md`),
        staged: path.join('.transaction', 'staged', '0.stage'),
        backup: path.join('.transaction', 'backups', '0.backup'),
        existed: true,
      }],
    })}\n`);

    await expect(store.get(ids.a)).rejects.toThrow(/transaction journal.*corrupt/i);
    await expect(store.get(ids.a)).rejects.toThrow(/transaction journal.*corrupt/i);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
    expect(await fs.readFile(path.join(transaction, 'journal.json'), 'utf8')).toContain(ids.a);
  });

  it.each([
    ['applying backup', 'backups/0.backup', 0, 0],
    ['committed staged file', 'staged/0.stage', null, 1],
  ] as const)('rejects a symlinked %s artifact without following it', async (
    _name,
    linkedArtifact,
    applyingIndex,
    appliedCount,
  ) => {
    await store.put(entry());
    const knowledge = path.join(root, 'knowledge');
    const target = path.join(knowledge, 'workspace', `${ids.a}.md`);
    const transaction = path.join(knowledge, '.transaction');
    const external = await fs.mkdtemp(path.join(tmpdir(), 'acs-external-artifact-'));
    const sentinel = path.join(external, 'sentinel.md');
    await fs.writeFile(sentinel, 'outside sentinel');
    await fs.mkdir(path.join(transaction, 'backups'), { recursive: true });
    await fs.mkdir(path.join(transaction, 'staged'), { recursive: true });
    await fs.writeFile(path.join(transaction, 'backups/0.backup'), await fs.readFile(target, 'utf8'));
    await fs.writeFile(path.join(transaction, 'staged/0.stage'), serializeKnowledge(entry({
      status: 'archived',
    })));
    await fs.rm(path.join(transaction, linkedArtifact));
    await fs.symlink(sentinel, path.join(transaction, linkedArtifact));
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999_999,
      applying_index: applyingIndex,
      applied_count: appliedCount,
      operations: [{
        target: path.join('workspace', `${ids.a}.md`),
        staged: path.join('.transaction', 'staged', '0.stage'),
        backup: path.join('.transaction', 'backups', '0.backup'),
        existed: true,
      }],
    })}\n`);

    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
    expect(await fs.readFile(path.join(transaction, 'journal.json'), 'utf8')).toContain(ids.a);
  });

  it('rejects journal metadata whose target is not the entry ID-derived path', async () => {
    await store.put(entry());
    const knowledge = path.join(root, 'knowledge');
    const transaction = path.join(knowledge, '.transaction');
    await fs.mkdir(path.join(transaction, 'backups'), { recursive: true });
    await fs.mkdir(path.join(transaction, 'staged'), { recursive: true });
    await fs.writeFile(path.join(transaction, 'backups/0.backup'), serializeKnowledge(entry()));
    await fs.writeFile(path.join(transaction, 'staged/0.stage'), serializeKnowledge(entry()));
    await fs.writeFile(path.join(transaction, 'journal.json'), `${JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999_999,
      applying_index: 0,
      applied_count: 0,
      operations: [{
        target: path.join('workspace', `${ids.b}.md`),
        staged: path.join('.transaction', 'staged', '0.stage'),
        backup: path.join('.transaction', 'backups', '0.backup'),
        existed: true,
      }],
    })}\n`);

    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    await expect(store.list()).rejects.toThrow(/transaction journal.*corrupt/i);
    expect(await fs.readFile(path.join(transaction, 'journal.json'), 'utf8')).toContain(ids.b);
  });

  it('rejects a symbolic transaction journal without touching its target', async () => {
    await fs.mkdir(path.join(root, 'knowledge'), { recursive: true });
    const external = await fs.mkdtemp(path.join(tmpdir(), 'acs-external-transaction-'));
    const marker = path.join(external, 'marker.txt');
    await fs.writeFile(marker, 'outside');
    await fs.symlink(external, path.join(root, 'knowledge/.transaction'));

    await expect(store.list()).rejects.toThrow(/transaction.*non-symbolic directory/i);
    expect(await fs.readFile(marker, 'utf8')).toBe('outside');
  });
});
