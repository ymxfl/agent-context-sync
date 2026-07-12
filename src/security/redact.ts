export type RedactionKind = 'secret' | 'private-key' | 'credential-url' | 'local-root' | 'absolute-path';

export interface RedactionFinding {
  readonly kind: RedactionKind;
  readonly replacement: string;
}

export interface RedactionResult {
  readonly redacted: string;
  readonly findings: readonly RedactionFinding[];
}

const SECRET = '[REDACTED_SECRET]';
const PRIVATE_KEY = '[REDACTED_PRIVATE_KEY]';
const CREDENTIAL = '[REDACTED_CREDENTIAL]';
const REPOSITORY_ROOT = '[REPOSITORY_ROOT]';
const REDACTED_PATH = '[REDACTED_PATH]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stashMatches(
  value: string,
  pattern: RegExp,
  stash: string[],
  prefix: string,
): string {
  return value.replace(pattern, (match) => {
    const marker = `\u0000${prefix}${stash.length}\u0000`;
    stash.push(match);
    return marker;
  });
}

function restoreMatches(value: string, stash: readonly string[], prefix: string): string {
  return value.replace(new RegExp(`\\u0000${prefix}(\\d+)\\u0000`, 'g'), (_match, index: string) => (
    stash[Number(index)] ?? ''
  ));
}

/**
 * Removes values that must never be sent to an extraction agent. Findings only
 * describe the class of redaction; they intentionally never retain matched text.
 */
export function redactCandidate(value: string, localRoots: string[]): RedactionResult {
  const findings: RedactionFinding[] = [];
  let redacted = value;

  const replace = (
    pattern: RegExp,
    replacement: string | ((...args: string[]) => string),
    kind: RedactionKind,
  ): void => {
    redacted = redacted.replace(pattern, (...args: string[]) => {
      findings.push({ kind, replacement: typeof replacement === 'string' ? replacement : '[REDACTED]' });
      return typeof replacement === 'string' ? replacement : replacement(...args);
    });
  };

  replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    PRIVATE_KEY,
    'private-key',
  );

  replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|sk-(?:live-|test-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    SECRET,
    'secret',
  );

  const assignmentKey = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)`;
  replace(
    new RegExp(`(\\b${assignmentKey}\\b\\s*[:=]\\s*)(["'])(.*?)\\2`, 'gi'),
    (_match, prefix, quote) => `${prefix}${quote}${SECRET}${quote}`,
    'secret',
  );
  replace(
    new RegExp(`(\\b${assignmentKey}\\b\\s*[:=]\\s*)([^\\s,;]+)`, 'gi'),
    (_match, prefix) => `${prefix}${SECRET}`,
    'secret',
  );

  replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    (_match, scheme) => `${scheme}${CREDENTIAL}@`,
    'credential-url',
  );

  const sortedRoots = [...localRoots]
    .filter((root) => root.length > 0)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  for (const root of sortedRoots) {
    const pattern = new RegExp(`${escapeRegExp(root)}(?=$|[/\\\\])`, 'g');
    replace(pattern, REPOSITORY_ROOT, 'local-root');
  }

  // URL paths and already-redacted repository-relative paths are not local
  // absolute paths. Hide them while scanning for unregistered filesystem paths.
  const protectedValues: string[] = [];
  redacted = stashMatches(redacted, /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, protectedValues, 'URL');
  redacted = stashMatches(
    redacted,
    /\[REPOSITORY_ROOT\](?:[/\\][^\s<>"'`,;)}\]]+)?/g,
    protectedValues,
    'ROOT',
  );

  replace(/(?:[A-Za-z]:\\|\\\\)[^\s<>"'`,;)}\]]+/g, REDACTED_PATH, 'absolute-path');
  replace(
    /(^|[^A-Za-z0-9._\]-])(\/(?:[^\s/<>"'`,;)}\]]+\/)*[^\s/<>"'`,;)}\]]+)/g,
    (_match, prefix) => `${prefix}${REDACTED_PATH}`,
    'absolute-path',
  );

  redacted = restoreMatches(redacted, protectedValues, 'ROOT');
  redacted = restoreMatches(redacted, protectedValues, 'URL');

  return { redacted, findings };
}
