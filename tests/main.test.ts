import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.js';

describe('run', () => {
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
});
