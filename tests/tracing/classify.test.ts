import { describe, expect, it } from 'vitest';

import type { CoverageReport } from '../../src/adapters/adapter.js';
import type { TraceEvent } from '../../src/tracing/provider.js';
import { classifyTrace } from '../../src/tracing/classify.js';

const stableReport: CoverageReport = {
  agent: 'claude-code',
  sources: [{
    agent: 'claude-code',
    sourceType: 'project-instructions',
    locator: '/tmp/repo/CLAUDE.md',
    shareability: 'team',
    status: 'available',
  }],
  coverage: [{
    id: 'claude-known-sources',
    status: 'partial',
    locator: '/tmp/repo/CLAUDE.md',
    detail: 'Stable adapter coverage for CLAUDE.md',
  }],
  loadPlan: [{
    order: 0,
    locator: '/tmp/repo/CLAUDE.md',
    sourceType: 'project-instructions',
    loading: 'eager',
  }],
};

const events: TraceEvent[] = [
  {
    timestamp: '16:20:51.693058',
    pid: 2315137,
    operation: 'open',
    path: '/tmp/repo/CLAUDE.md',
  },
  {
    timestamp: '16:20:51.693150',
    pid: 2315137,
    operation: 'lstat64',
    path: '/tmp/repo/src/main.ts',
  },
  {
    timestamp: '16:20:51.693200',
    pid: 2315137,
    operation: 'readlink',
    path: '/tmp/repo/custom.rules',
  },
  {
    timestamp: '16:20:51.693250',
    pid: 2315138,
    operation: 'open',
    path: '/tmp/repo/AGENTS.md',
  },
  {
    timestamp: '16:20:51.693800',
    pid: 2315137,
    operation: 'open',
    path: '/usr/lib/libc.so.6',
  },
];

describe('classifyTrace', () => {
  it('returns unknown context candidates and never includes file contents', () => {
    const candidates = classifyTrace(events, stableReport);

    expect(candidates.map((item) => item.path)).toContain('/tmp/repo/custom.rules');
    expect(candidates.map((item) => item.path)).toContain('/tmp/repo/AGENTS.md');
    expect(candidates.map((item) => item.path)).not.toContain('/tmp/repo/CLAUDE.md');
    expect(candidates.map((item) => item.path)).not.toContain('/tmp/repo/src/main.ts');
    expect(candidates.map((item) => item.path)).not.toContain('/usr/lib/libc.so.6');
    expect(JSON.stringify(candidates)).not.toContain('file contents');
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('content');
      expect(candidate).not.toHaveProperty('excerpt');
      expect(typeof candidate.path).toBe('string');
      expect(typeof candidate.reason).toBe('string');
    }
  });
});
