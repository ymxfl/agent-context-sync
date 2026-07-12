import { describe, expect, it } from 'vitest';
import { parseVerificationProposal } from '../../src/schema/verification.js';

const hash = `sha256:${'c'.repeat(64)}`;
const repoId = 'github.com/acme/api';
const knowledgeId = 'kn_01J00000000000000000000000';
const commit = 'a'.repeat(40);

const fileEvidence = {
  type: 'file' as const,
  repo_id: repoId,
  path: 'package.json',
  start_line: 12,
  end_line: 12,
  content_hash: hash,
};

const finding = {
  knowledge_id: knowledgeId,
  status: 'contradicted' as const,
  explanation: 'The package now uses Prisma.',
  evidence: [fileEvidence],
  proposed_action: {
    type: 'supersede' as const,
    statement: 'Use Prisma for persistence.',
    reason: 'The active dependency and code imports use Prisma.',
  },
};

const proposal = {
  schema_version: 1 as const,
  packet_id: 'packet_01J00000000000000000000000',
  packet_hash: hash,
  findings: [finding],
};

describe('parseVerificationProposal', () => {
  it('accepts a contradicted finding with file evidence and supersede action', () => {
    expect(parseVerificationProposal(proposal)).toBeTruthy();
    expect(parseVerificationProposal(proposal).findings[0]?.status).toBe('contradicted');
  });

  it('rejects stale findings with empty evidence', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{ ...finding, status: 'stale', evidence: [] }],
    })).toThrow(/evidence/i);
  });

  it('accepts unverifiable findings without evidence when attempted_checks are present', () => {
    const unverifiable = parseVerificationProposal({
      ...proposal,
      findings: [{
        knowledge_id: knowledgeId,
        status: 'unverifiable',
        explanation: 'No matching dependency or import evidence was found.',
        evidence: [],
        attempted_checks: [
          'searched package.json for prisma',
          'searched src for prisma imports',
        ],
        proposed_action: { type: 'none' },
      }],
    });
    expect(unverifiable.findings[0]?.status).toBe('unverifiable');
  });

  it('rejects unverifiable findings without attempted_checks', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        knowledge_id: knowledgeId,
        status: 'unverifiable',
        explanation: 'Insufficient material.',
        evidence: [],
        proposed_action: { type: 'none' },
      }],
    })).toThrow(/attempted_checks/i);
  });

  it('accepts all evidence kinds with strict path, line, and commit rules', () => {
    const accepted = parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'valid',
        explanation: 'Evidence still supports the rule.',
        evidence: [
          fileEvidence,
          {
            type: 'dependency',
            repo_id: repoId,
            manifest_path: 'package.json',
            name: 'prisma',
            version: '5.0.0',
            content_hash: hash,
          },
          {
            type: 'config',
            repo_id: repoId,
            path: 'tsconfig.json',
            start_line: 1,
            end_line: 3,
            content_hash: hash,
          },
          {
            type: 'git-commit',
            repo_id: repoId,
            commit,
          },
        ],
        proposed_action: { type: 'none' },
      }],
    });
    expect(accepted.findings[0]?.evidence).toHaveLength(4);
  });

  it('rejects unsafe paths and invalid line ordering', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ ...fileEvidence, path: '../package.json' }],
      }],
    })).toThrow(/path/i);
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ ...fileEvidence, path: '/abs/package.json' }],
      }],
    })).toThrow(/path/i);
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ ...fileEvidence, start_line: 0, end_line: 1 }],
      }],
    })).toThrow();
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ ...fileEvidence, start_line: 5, end_line: 4 }],
      }],
    })).toThrow(/line/i);
  });

  it('rejects malformed git commits', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ type: 'git-commit', repo_id: repoId, commit: 'ABC' }],
      }],
    })).toThrow(/commit/i);
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ type: 'git-commit', repo_id: repoId, commit: 'A'.repeat(40) }],
      }],
    })).toThrow(/commit/i);
  });

  it('rejects valid findings that propose mutation', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'valid',
        explanation: 'Still correct.',
        proposed_action: {
          type: 'update',
          statement: 'Changed statement.',
          reason: 'Should not mutate when valid.',
        },
      }],
    })).toThrow(/valid|mutation|proposed_action/i);
  });

  it('requires reasoned mutation or explicit none for stale and contradicted', () => {
    expect(parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'stale',
        explanation: 'The dependency moved on.',
        proposed_action: { type: 'none' },
      }],
    }).findings[0]?.proposed_action.type).toBe('none');

    expect(parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'stale',
        explanation: 'The dependency moved on.',
        proposed_action: {
          type: 'update',
          statement: 'Prefer Prisma for persistence.',
          reason: 'package.json now lists prisma.',
        },
      }],
    }).findings[0]?.proposed_action.type).toBe('update');

    expect(parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'stale',
        explanation: 'No longer applicable.',
        proposed_action: {
          type: 'archive',
          reason: 'Repository no longer ships this stack.',
        },
      }],
    }).findings[0]?.proposed_action.type).toBe('archive');

    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'stale',
        explanation: 'The dependency moved on.',
        proposed_action: { type: 'update', statement: 'Prefer Prisma.', reason: '' },
      }],
    })).toThrow(/reason/i);
  });

  it('strictly validates packet identity and knowledge ids', () => {
    expect(() => parseVerificationProposal({ ...proposal, packet_id: 'packet_bad' })).toThrow();
    expect(() => parseVerificationProposal({
      ...proposal,
      packet_hash: 'not-a-hash',
    })).toThrow();
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{ ...finding, knowledge_id: 'bad-id' }],
    })).toThrow();
  });

  it('rejects unknown fields on proposal, findings, and evidence', () => {
    expect(() => parseVerificationProposal({ ...proposal, extra: true })).toThrow(/unrecognized/i);
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{ ...finding, note: 'extra' }],
    })).toThrow(/unrecognized/i);
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        evidence: [{ ...fileEvidence, snippet: 'secret' }],
      }],
    })).toThrow(/unrecognized/i);
  });

  it('rejects contradicted findings with empty evidence', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{ ...finding, evidence: [] }],
    })).toThrow(/evidence/i);
  });

  it('rejects valid findings with empty evidence', () => {
    expect(() => parseVerificationProposal({
      ...proposal,
      findings: [{
        ...finding,
        status: 'valid',
        explanation: 'Still correct.',
        evidence: [],
        proposed_action: { type: 'none' },
      }],
    })).toThrow(/evidence/i);
  });
});
