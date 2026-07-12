import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { parseRepositoryBindings, run } from '../src/main.js';
import { previewInputHash, type WorkspacePreview } from '../src/workspace/context-repository.js';
import { savePreview } from '../src/workspace/preview-store.js';

describe('run', () => {
  it('parses repeatable explicit repository bindings', () => {
    expect(parseRepositoryBindings([
      'github.com/acme/api=/work/api',
      'github.com/acme/web=/work/web=clone',
    ])).toEqual({
      'github.com/acme/api': '/work/api',
      'github.com/acme/web': '/work/web=clone',
    });
    expect(() => parseRepositoryBindings(['github.com/acme/api']))
      .toThrow(/repo_id=path/i);
    expect(() => parseRepositoryBindings([
      'github.com/acme/api=/work/api',
      'github.com/acme/api=/work/other',
    ])).toThrow(/duplicate/i);
  });

  it('returns structured help without writing to stderr', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const code = await run(['help'], { stdout, stderr });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      ok: true,
      command: 'help',
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('preserves sanitized AppError remediation details in JSON envelopes', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'acs-main-details-'));
    vi.stubEnv('AGENT_CONTEXT_SYNC_HOME', home);
    try {
      const normalizedInput = {
        name: 'platform',
        context_remote: 'git@github.com:acme/context.git',
        scan_root: home,
        max_depth: 1,
        home,
      };
      const repositories = [{
        schema_version: 1 as const,
        repo_id: 'github.com/acme/api',
        name: 'api',
        candidate_paths: ['/work/api-a', '/work/api-b'],
      }];
      const approval = {
        workspace_id: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        files_to_write: [],
        repositories,
        warnings: ['explicit binding required'],
      };
      const preview: WorkspacePreview = {
        operation: 'init',
        preview_id: 'preview_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        input_hash: previewInputHash('init', normalizedInput, 'UNBORN', approval),
        context_head: 'UNBORN',
        normalized_input: normalizedInput,
        ...approval,
      };
      await savePreview(home, preview);
      const stdout = vi.fn();
      const code = await run(['init', 'apply', '--preview-id', preview.preview_id], {
        stdout,
        stderr: vi.fn(),
      });
      expect(code).toBe(2);
      expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
        error: {
          code: 'AMBIGUOUS_BINDING',
          details: {
            repo_id: 'github.com/acme/api',
            candidate_paths: ['/work/api-a', '/work/api-b'],
          },
        },
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
