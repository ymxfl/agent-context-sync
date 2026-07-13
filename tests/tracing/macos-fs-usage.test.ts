import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MacOsFsUsageProvider,
  parseFsUsage,
} from '../../src/tracing/macos-fs-usage.js';

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/tracing',
);

describe('parseFsUsage', () => {
  it('parses open/stat/readlink-style path events from fixture text', async () => {
    const fixture = await fs.readFile(path.join(fixtureDir, 'fs_usage_sample.txt'), 'utf8');
    const events = parseFsUsage(fixture);

    expect(events).toContainEqual(expect.objectContaining({
      operation: 'open',
      path: '/tmp/repo/CLAUDE.md',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      operation: 'stat64',
      path: '/tmp/repo/package.json',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      operation: 'readlink',
      path: '/tmp/repo/custom.rules',
    }));
    expect(events.every((event) => typeof event.timestamp === 'string')).toBe(true);
    expect(events.every((event) => typeof event.pid === 'number')).toBe(true);
    expect(events.some((event) => event.operation === 'write')).toBe(false);
    expect(events.some((event) => event.operation === 'close')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('file contents');
  });
});

describe('MacOsFsUsageProvider', () => {
  it('reports availability only on macOS when fs_usage is usable', async () => {
    const provider = new MacOsFsUsageProvider();
    const available = await provider.isAvailable();
    if (process.platform !== 'darwin') {
      expect(available).toBe(false);
      return;
    }
    expect(typeof available).toBe('boolean');
  });

  it('skips live smoke when the provider is unavailable', async () => {
    const provider = new MacOsFsUsageProvider();
    const available = await provider.isAvailable();
    if (!available) {
      expect(provider.unavailableReason()).toMatch(/fs_usage|macOS|authorized|unavailable/i);
      return;
    }

    await provider.start('node', ['-e', 'require("fs").readFileSync("/etc/hosts")']);
    const events = await provider.stop();
    expect(Array.isArray(events)).toBe(true);
  });
});
