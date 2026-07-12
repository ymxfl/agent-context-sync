import { z } from 'zod';
import type {
  KnowledgeEntry,
  KnowledgeParseContext,
  KnowledgeScope,
  ProposedKnowledge,
  SourceReference,
} from '../domain/model.js';

const kebabCaseSchema = z.string().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'Value must be a non-empty kebab-case string',
);

const repositoryIdSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?\/[^\s\\/?#]+(?:\/[^\s\\/?#]+)*$/,
  'Repository ID must be a normalized host/path string',
).refine((value) => !value.endsWith('.git'), {
  message: 'Repository ID must not include a .git suffix',
}).refine((value) => {
  const repositoryPath = value.slice(value.indexOf('/') + 1);
  return repositoryPath.split('/').every((segment) => segment !== '.' && segment !== '..');
}, {
  message: 'Repository ID must not contain dot path segments',
});

export const knowledgeIdSchema = z.string().regex(
  /^kn_[0-9A-HJKMNP-TV-Z]{26}$/,
  'Knowledge ID must use the kn_ prefix and 26 Crockford Base32 characters',
);

export const contentHashSchema = z.string().regex(
  /^sha256:[0-9a-f]{64}$/,
  'Content hash must be a lowercase SHA-256 digest',
);

const timestampSchema = z.iso.datetime({ offset: true });
const nonEmptyStringSchema = z.string().trim().min(1);

function isLogicalLocator(value: string): boolean {
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || /^[a-z]:/i.test(value)
    || /^file:/i.test(value)
    || value.includes('\\')
  ) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

const logicalLocatorSchema = nonEmptyStringSchema.refine(isLogicalLocator, {
  message: 'Source locator must be a redacted logical locator',
});

function isRepositoryRelativePosixGlob(value: string): boolean {
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || /^[a-z]:/i.test(value)
    || /^file:/i.test(value)
    || value.includes('\\')
  ) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..' && segment !== '');
}

const repositoryRelativePosixGlobSchema = nonEmptyStringSchema.refine(
  isRepositoryRelativePosixGlob,
  { message: 'applies_to paths must be repository-relative POSIX globs' },
);

export const sourceReferenceSchema: z.ZodType<SourceReference> = z.strictObject({
  agent: nonEmptyStringSchema,
  source_type: kebabCaseSchema,
  locator: logicalLocatorSchema,
  content_hash: contentHashSchema,
  observed_at: timestampSchema,
});

const appliesToSchema = z.strictObject({
  paths: z.array(repositoryRelativePosixGlobSchema),
  agents: z.array(nonEmptyStringSchema),
});

const scopeSchema = z.custom<KnowledgeScope>(
  (value) => typeof value === 'string' && (
    value === 'workspace'
    || (
      value.startsWith('repository:')
      && repositoryIdSchema.safeParse(value.slice('repository:'.length)).success
    )
  ),
  'Scope must be workspace or repository:<normalized-repo-id>',
);

function uniqueRelationsSchema(relation: string) {
  return z.array(knowledgeIdSchema).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `${relation} relations must be unique`,
        });
      }
      seen.add(value);
    }
  });
}

function overlappingRelationIndexes(
  value: Pick<ProposedKnowledge, 'supersedes' | 'conflicts_with'>,
): number[] {
  const supersedes = new Set(value.supersedes);
  return value.conflicts_with
    .map((target, index) => supersedes.has(target) ? index : -1)
    .filter((index) => index !== -1);
}

export const proposedKnowledgeSchema: z.ZodType<ProposedKnowledge> = z.strictObject({
  kind: kebabCaseSchema,
  scope: scopeSchema,
  applies_to: appliesToSchema,
  source: sourceReferenceSchema,
  confidence: z.number().finite().min(0).max(1),
  supersedes: uniqueRelationsSchema('supersedes'),
  conflicts_with: uniqueRelationsSchema('conflicts_with'),
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
}).superRefine((candidate, context) => {
  for (const index of overlappingRelationIndexes(candidate)) {
    context.addIssue({
      code: 'custom',
      path: ['conflicts_with', index],
      message: 'supersedes and conflicts_with relations must not overlap',
    });
  }
});

const knowledgeEntrySchema: z.ZodType<KnowledgeEntry> = z.strictObject({
  schema_version: z.literal(1),
  id: knowledgeIdSchema,
  kind: kebabCaseSchema,
  scope: scopeSchema,
  status: z.enum(['active', 'superseded', 'archived', 'disputed']),
  applies_to: appliesToSchema,
  source: sourceReferenceSchema,
  confidence: z.number().finite().min(0).max(1),
  supersedes: uniqueRelationsSchema('supersedes'),
  conflicts_with: uniqueRelationsSchema('conflicts_with'),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  last_verified_at: timestampSchema.nullable(),
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
}).superRefine((entry, context) => {
  for (const index of overlappingRelationIndexes(entry)) {
    context.addIssue({
      code: 'custom',
      path: ['conflicts_with', index],
      message: 'supersedes and conflicts_with relations must not overlap',
    });
  }

  for (const relation of ['supersedes', 'conflicts_with'] as const) {
    for (const [index, target] of entry[relation].entries()) {
      if (target === entry.id) {
        context.addIssue({
          code: 'custom',
          path: [relation, index],
          message: `${relation} must not reference the entry itself`,
        });
      }
    }
  }

  const observedAt = Date.parse(entry.source.observed_at);
  const createdAt = Date.parse(entry.created_at);
  const updatedAt = Date.parse(entry.updated_at);
  if (observedAt > updatedAt) {
    context.addIssue({
      code: 'custom',
      path: ['source', 'observed_at'],
      message: 'observed_at must be on or before updated_at',
    });
  }
  if (createdAt > updatedAt) {
    context.addIssue({
      code: 'custom',
      path: ['created_at'],
      message: 'created_at must be on or before updated_at',
    });
  }
  if (entry.last_verified_at !== null) {
    const lastVerifiedAt = Date.parse(entry.last_verified_at);
    if (lastVerifiedAt < createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['last_verified_at'],
        message: 'last_verified_at must be on or after created_at',
      });
    }
    if (lastVerifiedAt > updatedAt) {
      context.addIssue({
        code: 'custom',
        path: ['last_verified_at'],
        message: 'last_verified_at must be on or before updated_at',
      });
    }
  }
});

export function assertRegisteredKnowledgeScope(
  scope: KnowledgeScope,
  context?: KnowledgeParseContext,
): void {
  if (scope === 'workspace') return;
  if (context === undefined) {
    throw new Error('Repository scope requires KnowledgeParseContext');
  }
  const repositoryId = scope.slice('repository:'.length);
  if (!context.registeredRepositoryIds.has(repositoryId)) {
    throw new Error('Repository scope is not registered in KnowledgeParseContext');
  }
}

export function parseKnowledgeEntry(
  value: unknown,
  context?: KnowledgeParseContext,
): KnowledgeEntry {
  const entry = knowledgeEntrySchema.parse(value);
  assertRegisteredKnowledgeScope(entry.scope, context);
  return entry;
}
