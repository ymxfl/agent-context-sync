import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LinuxStraceProvider,
  parseStrace,
} from '../../src/tracing/linux-strace.js';

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/tracing',
);

describe('parseStrace', () => {
  it('parses openat/stat/readlink-style path events from fixture text', async () => {
    const fixture = await fs.readFile(path.join(fixtureDir, 'strace_sample.txt'), 'utf8');
    const events = parseStrace(fixture);

    expect(events).toContainEqual(expect.objectContaining({
      operation: 'openat',
      path: '/tmp/repo/AGENTS.md',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      operation: 'stat',
      path: '/tmp/repo/package.json',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      operation: 'readlink',
      path: '/tmp/repo/custom.rules',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      operation: 'newfstatat',
      path: '/tmp/repo/src/main.ts',
    }));
    expect(events.every((event) => typeof event.timestamp === 'string')).toBe(true);
    expect(events.every((event) => typeof event.pid === 'number')).toBe(true);
    expect(events.some((event) => event.operation === 'write')).toBe(false);
    expect(events.some((event) => event.operation === 'close')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('file contents');
  });
});

describe('LinuxStraceProvider', () => {
  it('reports availability only on Linux when strace and ptrace are usable', async () => {
    const provider = new LinuxStraceProvider();
    const available = await provider.isAvailable();
    if (process.platform !== 'linux') {
      expect(available).toBe(false);
      return;
    }
    expect(typeof available).toBe('boolean');
  });

  it('skips live smoke when the provider is unavailable', async () => {
    const provider = new LinuxStraceProvider();
    const available = await provider.isAvailable();
    if (!available) {
      expect(provider.unavailableReason()).toMatch(/strace|ptrace|Linux|unavailable/i);
      return;
    }

    await provider.start('node', ['-e', 'require("fs").readFileSync("/etc/hosts")']);
    const events = await provider.stop();
    expect(Array.isArray(events)).toBe(true);
  });
});
