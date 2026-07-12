import { z } from 'zod';
import type {
  KnowledgeEntry,
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

export const sourceReferenceSchema: z.ZodType<SourceReference> = z.strictObject({
  agent: nonEmptyStringSchema,
  source_type: kebabCaseSchema,
  locator: nonEmptyStringSchema,
  content_hash: contentHashSchema,
  observed_at: timestampSchema,
});

const appliesToSchema = z.strictObject({
  paths: z.array(nonEmptyStringSchema),
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

export const proposedKnowledgeSchema: z.ZodType<ProposedKnowledge> = z.strictObject({
  kind: kebabCaseSchema,
  scope: scopeSchema,
  applies_to: appliesToSchema,
  source: sourceReferenceSchema,
  confidence: z.number().finite().min(0).max(1),
  supersedes: z.array(knowledgeIdSchema),
  conflicts_with: z.array(knowledgeIdSchema),
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
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
  supersedes: z.array(knowledgeIdSchema),
  conflicts_with: z.array(knowledgeIdSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  last_verified_at: timestampSchema.nullable(),
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
});

export function parseKnowledgeEntry(value: unknown): KnowledgeEntry {
  return knowledgeEntrySchema.parse(value);
}
