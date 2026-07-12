import { describe, expect, it } from 'vitest';
import { redactCandidate } from '../../src/security/redact.js';

describe('redactCandidate', () => {
  it('redacts common token prefixes and assignment-style secrets', () => {
    const value = [
      'token=ghp_abcdefghijklmnopqrstuvwxyz123456',
      'password: "correct horse battery staple"',
      'api_key = sk-live-1234567890abcdefghijklmnop',
      'bearer github_pat_11AA0abcdefghijklmnopqrstuvwxyz',
    ].join('\n');

    const result = redactCandidate(value, []);

    expect(result.redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(result.redacted).not.toContain('correct horse battery staple');
    expect(result.redacted).not.toContain('sk-live-1234567890abcdefghijklmnop');
    expect(result.redacted).not.toContain('github_pat_11AA0abcdefghijklmnopqrstuvwxyz');
    expect(result.redacted.match(/\[REDACTED_SECRET\]/g)?.length).toBeGreaterThanOrEqual(4);
    expect(result.findings.every((finding) => finding.kind === 'secret')).toBe(true);
  });

  it('redacts private keys and credential-bearing URLs', () => {
    const value = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'super-secret-key-material',
      '-----END OPENSSH PRIVATE KEY-----',
      'https://alice:password@example.test/private',
    ].join('\n');

    const result = redactCandidate(value, []);

    expect(result.redacted).not.toContain('super-secret-key-material');
    expect(result.redacted).not.toContain('alice:password');
    expect(result.redacted).toContain('[REDACTED_PRIVATE_KEY]');
    expect(result.redacted).toContain('https://[REDACTED_CREDENTIAL]@example.test/private');
  });

  it('replaces registered roots longest-first without exposing absolute paths', () => {
    const roots = ['/Users/alice/work', '/Users/alice/work/api'];
    const input = [
      '/Users/alice/work/api/src/a.ts',
      '/Users/alice/work/docs/guide.md',
      String.raw`C:\Users\alice\private\notes.txt`,
      '/opt/unregistered/private.txt',
    ].join('\n');

    const result = redactCandidate(input, roots);

    expect(result.redacted).toContain('[REPOSITORY_ROOT]/src/a.ts');
    expect(result.redacted).toContain('[REPOSITORY_ROOT]/docs/guide.md');
    expect(result.redacted).not.toContain('/Users/alice');
    expect(result.redacted).not.toContain('C:\\Users\\alice');
    expect(result.redacted).not.toContain('/opt/unregistered');
    expect(result.redacted.match(/\[REDACTED_PATH\]/g)).toHaveLength(2);
  });

  it('does not mutate the registered roots input', () => {
    const roots = ['/workspace', '/workspace/repository'];
    const original = [...roots];

    redactCandidate('/workspace/repository/AGENTS.md', roots);

    expect(roots).toEqual(original);
  });

  it('preserves logical slash-delimited identifiers while removing absolute paths', () => {
    const result = redactCandidate([
      'repository:github.com/acme/api',
      'memory/MEMORY.md',
      'path=`/etc/passwd`',
    ].join('\n'), []);

    expect(result.redacted).toContain('repository:github.com/acme/api');
    expect(result.redacted).toContain('memory/MEMORY.md');
    expect(result.redacted).not.toContain('/etc/passwd');
    expect(result.redacted).toContain('path=`[REDACTED_PATH]`');
  });
});
