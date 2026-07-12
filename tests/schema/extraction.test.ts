import { describe, expect, it } from 'vitest';
import { parseExtractionProposal } from '../../src/schema/extraction.js';

const hash = `sha256:${'b'.repeat(64)}`;
const now = '2026-07-11T10:00:00Z';
const source = {
  agent: 'third-party-agent',
  source_type: 'project-instruction',
  locator: 'AGENTS.md',
  content_hash: hash,
  observed_at: now,
};
const proposed = {
  kind: 'workflow',
  scope: 'workspace',
  applies_to: { paths: [], agents: ['third-party-agent'] },
  source,
  confidence: 0.8,
  supersedes: [],
  conflicts_with: [],
  statement: 'Run the focused tests before the full suite.',
  reason: 'Focused failures are faster to diagnose.',
};
const proposal = {
  schema_version: 1,
  packet_id: 'packet_01J00000000000000000000000',
  accepted: [proposed],
  rejected: [{ source, reason: 'The remaining text is personal and not shareable.' }],
};

describe('parseExtractionProposal', () => {
  it('accepts empty accepted and rejected lists', () => {
    expect(() => parseExtractionProposal({ ...proposal, accepted: [], rejected: [] })).not.toThrow();
  });

  it('accepts structured candidates with open kinds and Agent names', () => {
    expect(parseExtractionProposal(proposal).accepted[0]).toEqual(proposed);
  });

  it('rejects canonical-only fields on proposed knowledge', () => {
    expect(() => parseExtractionProposal({
      ...proposal,
      accepted: [{ ...proposed, id: 'kn_01J00000000000000000000000' }],
    })).toThrow(/unrecognized/i);
    expect(() => parseExtractionProposal({
      ...proposal,
      accepted: [{ ...proposed, status: 'active' }],
    })).toThrow(/unrecognized/i);
  });

  it('strictly validates packet identity, accepted relations, and rejection reasons', () => {
    expect(() => parseExtractionProposal({ ...proposal, packet_id: 'packet_bad' })).toThrow();
    expect(() => parseExtractionProposal({
      ...proposal,
      accepted: [{ ...proposed, conflicts_with: ['bad-id'] }],
    })).toThrow();
    expect(() => parseExtractionProposal({
      ...proposal,
      rejected: [{ source, reason: '' }],
    })).toThrow();
  });

  it('rejects unknown proposal and rejection fields', () => {
    expect(() => parseExtractionProposal({ ...proposal, explanation: 'extra' })).toThrow(/unrecognized/i);
    expect(() => parseExtractionProposal({
      ...proposal,
      rejected: [{ source, reason: 'irrelevant', private: true }],
    })).toThrow(/unrecognized/i);
  });
});
