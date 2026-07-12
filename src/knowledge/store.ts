import * as fs from 'node:fs/promises';
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

  constructor(
    contextRoot: string,
    private readonly context?: KnowledgeParseContext,
  ) {
    this.root = path.resolve(contextRoot, 'knowledge');
    assertContained(path.resolve(contextRoot), this.root);
  }

  private fileFor(entry: Pick<KnowledgeEntry, 'id' | 'scope'>): string {
    const relative = entry.scope === 'workspace'
      ? path.join('workspace', `${entry.id}.md`)
      : path.join('repositories', entry.scope.slice('repository:'.length), `${entry.id}.md`);
    const file = path.resolve(this.root, relative);
    assertContained(this.root, file);
    return file;
  }

  private async storedEntries(): Promise<StoredEntry[]> {
    const stored: StoredEntry[] = [];
    for (const file of await markdownFiles(this.root)) {
      const entry = parseKnowledgeMarkdown(await fs.readFile(file, 'utf8'), this.context);
      if (file !== this.fileFor(entry)) {
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
    return (await this.storedEntries()).map(({ entry }) => entry);
  }

  async get(id: string): Promise<KnowledgeEntry | undefined> {
    return (await this.storedEntries()).find(({ entry }) => entry.id === id)?.entry;
  }

  async put(entry: KnowledgeEntry): Promise<void> {
    const validated = parseKnowledgeEntry(entry, this.context);
    const stored = await this.storedEntries();
    const previous = stored.find((item) => item.entry.id === validated.id);
    const target = this.fileFor(validated);
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
    for (const current of entries) {
      const old = stored.find((item) => item.entry.id === current.id)?.entry;
      if (old === undefined || serializeKnowledge(old) !== serializeKnowledge(current)) {
        await atomicWriteFile(this.fileFor(current), serializeKnowledge(current));
      }
    }
  }
}
