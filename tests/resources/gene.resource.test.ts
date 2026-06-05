/**
 * @fileoverview Tests for the ensembl://gene/{id} resource.
 * @module tests/resources/gene.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGeneResource } from '@/mcp-server/resources/definitions/gene.resource.js';
import type { GeneRecord } from '@/services/ensembl/types.js';

const mockLookupGeneById = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ lookupGeneById: mockLookupGeneById }),
}));

const brca2: GeneRecord = {
  id: 'ENSG00000139618',
  species: 'homo_sapiens',
  displayName: 'BRCA2',
  description: 'BRCA2 DNA repair associated',
  biotype: 'protein_coding',
  chromosome: '13',
  start: 32315086,
  end: 32400268,
  strand: 1,
  assemblyName: 'GRCh38',
  transcripts: [
    {
      id: 'ENST00000380152',
      displayName: 'BRCA2-201',
      biotype: 'protein_coding',
      isCanonical: true,
      start: 32315086,
      end: 32400268,
      strand: 1,
    },
  ],
};

describe('ensemblGeneResource', () => {
  it('returns gene record with all fields for a valid ID', async () => {
    mockLookupGeneById.mockResolvedValueOnce(brca2);
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params.parse({ id: 'ENSG00000139618' });
    const result = await ensemblGeneResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'ENSG00000139618',
      displayName: 'BRCA2',
      chromosome: '13',
      assemblyName: 'GRCh38',
    });
  });

  it('requests expanded transcripts (expand=true)', async () => {
    mockLookupGeneById.mockResolvedValueOnce(brca2);
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params.parse({ id: 'ENSG00000139618' });
    await ensemblGeneResource.handler(params, ctx);
    // Resource always fetches with expandTranscripts=true
    expect(mockLookupGeneById).toHaveBeenCalledWith('ENSG00000139618', true, expect.anything());
  });

  it('throws not_found when gene ID does not exist', async () => {
    mockLookupGeneById.mockRejectedValueOnce(
      new Error('Gene ENSG99999999999 not found in Ensembl'),
    );
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params.parse({ id: 'ENSG99999999999' });
    await expect(ensemblGeneResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('lists example resources', async () => {
    const listing = await ensemblGeneResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri as string).toMatch(/^ensembl:\/\/gene\//);
    }
  });

  it('returns sparse gene record without crash', async () => {
    const sparseGene: GeneRecord = { id: 'ENSG00000000001' };
    mockLookupGeneById.mockResolvedValueOnce(sparseGene);
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params.parse({ id: 'ENSG00000000001' });
    const result = await ensemblGeneResource.handler(params, ctx);
    expect((result as GeneRecord).id).toBe('ENSG00000000001');
  });
});
