import { z } from 'zod';
import type {
  ExtractionProposal,
  KnowledgeParseContext,
  RejectedCandidate,
} from '../domain/model.js';
import {
  assertRegisteredKnowledgeScope,
  proposedKnowledgeSchema,
  sourceReferenceSchema,
} from './knowledge.js';

const packetIdSchema = z.string().regex(
  /^packet_[0-9A-HJKMNP-TV-Z]{26}$/,
  'Packet ID must use the packet_ prefix and 26 Crockford Base32 characters',
);

const rejectedCandidateSchema: z.ZodType<RejectedCandidate> = z.strictObject({
  source: sourceReferenceSchema,
  reason: z.string().trim().min(1),
});

const extractionProposalSchema: z.ZodType<ExtractionProposal> = z.strictObject({
  schema_version: z.literal(1),
  packet_id: packetIdSchema,
  accepted: z.array(proposedKnowledgeSchema),
  rejected: z.array(rejectedCandidateSchema),
});

export function parseExtractionProposal(
  value: unknown,
  context?: KnowledgeParseContext,
): ExtractionProposal {
  const proposal = extractionProposalSchema.parse(value);
  for (const candidate of proposal.accepted) {
    assertRegisteredKnowledgeScope(candidate.scope, context);
  }
  return proposal;
}
