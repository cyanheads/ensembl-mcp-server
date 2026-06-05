/**
 * @fileoverview Tests for the ensembl://transcript/{id} resource.
 * @module tests/resources/transcript.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblTranscriptResource } from '@/mcp-server/resources/definitions/transcript.resource.js';
import type { TranscriptRecord } from '@/services/ensembl/types.js';

const mockLookupTranscript = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ lookupTranscript: mockLookupTranscript }),
}));

const canonicalTranscript: TranscriptRecord = {
  id: 'ENST00000380152',
  parentGeneId: 'ENSG00000139618',
  displayName: 'BRCA2-201',
  biotype: 'protein_coding',
  isCanonical: true,
  species: 'homo_sapiens',
  chromosome: '13',
  start: 32315086,
  end: 32400268,
  strand: 1,
  assemblyName: 'GRCh38',
  lengthInBp: 10257,
};

describe('ensemblTranscriptResource', () => {
  it('returns transcript record for valid ID', async () => {
    mockLookupTranscript.mockResolvedValueOnce(canonicalTranscript);
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params.parse({ id: 'ENST00000380152' });
    const result = await ensemblTranscriptResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'ENST00000380152',
      parentGeneId: 'ENSG00000139618',
      isCanonical: true,
      biotype: 'protein_coding',
    });
  });

  it('throws not_found when transcript ID does not exist', async () => {
    mockLookupTranscript.mockRejectedValueOnce(
      new Error('Transcript ENST99999999999 not found in Ensembl'),
    );
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params.parse({ id: 'ENST99999999999' });
    await expect(ensemblTranscriptResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('lists example resources', async () => {
    const listing = await ensemblTranscriptResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri as string).toMatch(/^ensembl:\/\/transcript\//);
    }
  });

  it('returns sparse transcript record without crash', async () => {
    const sparse: TranscriptRecord = { id: 'ENST00000000001', isCanonical: false };
    mockLookupTranscript.mockResolvedValueOnce(sparse);
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params.parse({ id: 'ENST00000000001' });
    const result = await ensemblTranscriptResource.handler(params, ctx);
    expect((result as TranscriptRecord).id).toBe('ENST00000000001');
    expect((result as TranscriptRecord).isCanonical).toBe(false);
  });
});
