import { z } from 'zod';
import type {
  EvidenceRef,
  ProposedVerificationAction,
  VerificationFinding,
  VerificationProposal,
} from '../domain/model.js';
import { contentHashSchema, knowledgeIdSchema } from './knowledge.js';

const packetIdSchema = z.string().regex(
  /^packet_[0-9A-HJKMNP-TV-Z]{26}$/,
  'Packet ID must use the packet_ prefix and 26 Crockford Base32 characters',
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

const nonEmptyStringSchema = z.string().trim().min(1);

function isRepositoryRelativePosixPath(value: string): boolean {
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || /^[a-z]:/i.test(value)
    || /^file:/i.test(value)
    || value.includes('\\')
  ) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..' && segment !== '');
}

const repositoryRelativePosixPathSchema = nonEmptyStringSchema.refine(
  isRepositoryRelativePosixPath,
  { message: 'Evidence path must be a repository-relative POSIX path' },
);

const positiveLineSchema = z.number().int().positive();

function assertOrderedLines(
  value: { start_line: number; end_line: number },
  context: z.RefinementCtx,
): void {
  if (value.start_line > value.end_line) {
    context.addIssue({
      code: 'custom',
      path: ['end_line'],
      message: 'end_line must be greater than or equal to start_line',
    });
  }
}

const fileEvidenceSchema = z.strictObject({
  type: z.literal('file'),
  repo_id: repositoryIdSchema,
  path: repositoryRelativePosixPathSchema,
  start_line: positiveLineSchema,
  end_line: positiveLineSchema,
  content_hash: contentHashSchema,
}).superRefine(assertOrderedLines);

const dependencyEvidenceSchema = z.strictObject({
  type: z.literal('dependency'),
  repo_id: repositoryIdSchema,
  manifest_path: repositoryRelativePosixPathSchema,
  name: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  content_hash: contentHashSchema,
});

const configEvidenceSchema = z.strictObject({
  type: z.literal('config'),
  repo_id: repositoryIdSchema,
  path: repositoryRelativePosixPathSchema,
  start_line: positiveLineSchema,
  end_line: positiveLineSchema,
  content_hash: contentHashSchema,
}).superRefine(assertOrderedLines);

const gitCommitEvidenceSchema = z.strictObject({
  type: z.literal('git-commit'),
  repo_id: repositoryIdSchema,
  commit: z.string().regex(
    /^[0-9a-f]{40}$/,
    'Git commit must be 40 lowercase hexadecimal characters',
  ),
});

const evidenceRefSchema: z.ZodType<EvidenceRef> = z.union([
  fileEvidenceSchema,
  dependencyEvidenceSchema,
  configEvidenceSchema,
  gitCommitEvidenceSchema,
]);

const noneActionSchema = z.strictObject({
  type: z.literal('none'),
});

const updateActionSchema = z.strictObject({
  type: z.literal('update'),
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
});

const supersedeActionSchema = z.strictObject({
  type: z.literal('supersede'),
  statement: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
});

const archiveActionSchema = z.strictObject({
  type: z.literal('archive'),
  reason: nonEmptyStringSchema,
});

const proposedActionSchema: z.ZodType<ProposedVerificationAction> = z.discriminatedUnion('type', [
  noneActionSchema,
  updateActionSchema,
  supersedeActionSchema,
  archiveActionSchema,
]);

const verificationFindingSchema: z.ZodType<VerificationFinding> = z.strictObject({
  knowledge_id: knowledgeIdSchema,
  status: z.enum(['valid', 'stale', 'contradicted', 'unverifiable']),
  explanation: nonEmptyStringSchema,
  evidence: z.array(evidenceRefSchema),
  proposed_action: proposedActionSchema,
  attempted_checks: z.array(nonEmptyStringSchema).optional(),
}).superRefine((finding, context) => {
  const requiresEvidence = finding.status === 'valid'
    || finding.status === 'stale'
    || finding.status === 'contradicted';

  if (requiresEvidence && finding.evidence.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: `${finding.status} findings must cite at least one evidence reference`,
    });
  }

  if (finding.status === 'unverifiable') {
    if (finding.attempted_checks === undefined || finding.attempted_checks.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['attempted_checks'],
        message: 'unverifiable findings must include attempted_checks',
      });
    }
  }

  if (finding.status === 'valid' && finding.proposed_action.type !== 'none') {
    context.addIssue({
      code: 'custom',
      path: ['proposed_action'],
      message: 'valid findings cannot propose mutation',
    });
  }

  if (
    (finding.status === 'stale' || finding.status === 'contradicted')
    && finding.proposed_action.type !== 'none'
    && !('reason' in finding.proposed_action)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['proposed_action'],
      message: 'stale and contradicted findings must propose a reasoned mutation or explicit none',
    });
  }
});

const verificationProposalSchema: z.ZodType<VerificationProposal> = z.strictObject({
  schema_version: z.literal(1),
  packet_id: packetIdSchema,
  packet_hash: contentHashSchema,
  findings: z.array(verificationFindingSchema),
});

export function parseVerificationProposal(value: unknown): VerificationProposal {
  return verificationProposalSchema.parse(value);
}
