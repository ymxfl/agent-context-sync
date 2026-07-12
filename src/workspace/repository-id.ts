function normalizePath(remotePath: string): string {
  if (remotePath.includes('\\')) {
    throw new Error('Remote must not contain invalid path segments');
  }
  const withoutQueryOrFragment = remotePath.split(/[?#]/, 1)[0] ?? '';
  const withoutSeparators = withoutQueryOrFragment.replace(/^\/+|\/+$/g, '');
  if (withoutSeparators.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Remote must not contain dot path segments');
  }
  return withoutSeparators.replace(/\.git$/i, '');
}

export function normalizeRemote(remote: string): string {
  const value = remote.trim();

  if (value.includes('://')) {
    const afterScheme = value.slice(value.indexOf('://') + 3);
    const rawPathStart = afterScheme.indexOf('/');
    if (rawPathStart >= 0) normalizePath(afterScheme.slice(rawPathStart));
    const parsed = new URL(value);
    const host = parsed.port
      ? `${parsed.hostname.toLowerCase()}:${parsed.port}`
      : parsed.hostname.toLowerCase();
    const remotePath = normalizePath(parsed.pathname);

    if (host.length === 0 || remotePath.length === 0) {
      throw new Error(`Remote must include a host and repository path: ${remote}`);
    }

    return `${host}/${remotePath}`;
  }

  const scpLike = /^(?:[^@/]+@)?([^:/?#]+):(.+)$/.exec(value);
  if (scpLike === null) {
    throw new Error(`Unsupported Git remote: ${remote}`);
  }

  const host = scpLike[1]?.toLowerCase() ?? '';
  const remotePath = normalizePath(scpLike[2] ?? '');
  if (host.length === 0 || remotePath.length === 0) {
    throw new Error(`Remote must include a host and repository path: ${remote}`);
  }

  return `${host}/${remotePath}`;
}

export function repositoryIdFromRemote(remote: string): string {
  return normalizeRemote(remote);
}
