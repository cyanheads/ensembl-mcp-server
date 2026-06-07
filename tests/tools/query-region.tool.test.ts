/**
 * @fileoverview Tests for the ensembl_query_region tool.
 * @module tests/tools/query-region.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblQueryRegion } from '@/mcp-server/tools/definitions/query-region.tool.js';
import type { OverlapFeature } from '@/services/ensembl/types.js';

const mockQueryRegion = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ queryRegion: mockQueryRegion }),
}));

const brca2Feature: OverlapFeature = {
  id: 'ENSG00000139618',
  name: 'BRCA2',
  featureType: 'gene',
  biotype: 'protein_coding',
  chromosome: '13',
  start: 32315086,
  end: 32400268,
  strand: 1,
  description: 'BRCA2 DNA repair associated',
};

describe('ensemblQueryRegion', () => {
  it('returns features for a valid region with default feature=gene', async () => {
    mockQueryRegion.mockResolvedValueOnce([brca2Feature]);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:32315086-32400268',
    });
    // default feature should be ['gene']
    expect(input.feature).toEqual(['gene']);
    const result = await ensemblQueryRegion.handler(input, ctx);
    expect(result.features).toHaveLength(1);
    expect(result.features[0]!.id).toBe('ENSG00000139618');
    expect(result.totalCount).toBe(1);
    expect(result.region).toBe('13:32315086-32400268');
    expect(result.species).toBe('homo_sapiens');
  });

  it('passes specified feature types to the service', async () => {
    mockQueryRegion.mockResolvedValueOnce([brca2Feature]);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:32315086-32400268',
      feature: ['gene', 'transcript'],
    });
    await ensemblQueryRegion.handler(input, ctx);
    expect(mockQueryRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32400268',
      ['gene', 'transcript'],
      undefined,
      expect.anything(),
    );
  });

  it('passes biotype filter to service when provided', async () => {
    mockQueryRegion.mockResolvedValueOnce([brca2Feature]);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:32315086-32400268',
      biotype: 'protein_coding',
    });
    await ensemblQueryRegion.handler(input, ctx);
    expect(mockQueryRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32400268',
      ['gene'],
      'protein_coding',
      expect.anything(),
    );
  });

  it('throws invalid_region on coordinate parse error', async () => {
    mockQueryRegion.mockRejectedValueOnce(new Error('invalid region coordinate parse error'));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: 'bad:region:format',
    });
    await expect(ensemblQueryRegion.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_region' },
    });
  });

  it('throws invalid_region when Ensembl returns "No slice found for location"', async () => {
    mockQueryRegion.mockRejectedValueOnce(new Error('No slice found for location notaregion'));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: 'notaregion',
    });
    await expect(ensemblQueryRegion.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_region' },
    });
  });

  it('throws invalid_species on unrecognized species', async () => {
    mockQueryRegion.mockRejectedValueOnce(new Error('species invalid unrecognized'));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'not_a_species',
      region: '1:1-1000',
    });
    await expect(ensemblQueryRegion.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_species' },
    });
  });

  it('returns empty features array and total 0 for empty results', async () => {
    mockQueryRegion.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '1:1-100',
    });
    const result = await ensemblQueryRegion.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.features).toHaveLength(0);
  });

  it('empty result notice includes chr-prefix guidance and lookup hint', async () => {
    mockQueryRegion.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:1000-2000',
    });
    await ensemblQueryRegion.handler(input, ctx);
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toContain('no "chr" prefix');
    expect(notice).toContain('ensembl_lookup_gene');
  });

  it('formats features with location and type', () => {
    const output = {
      features: [brca2Feature],
      totalCount: 1,
      region: '13:32315086-32400268',
      species: 'homo_sapiens',
    };
    const blocks = ensemblQueryRegion.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('BRCA2');
    expect(text).toContain('ENSG00000139618');
    expect(text).toContain('gene');
    expect(text).toContain('13:32315086-32400268');
    expect(text).toContain('homo_sapiens');
  });

  it('formats empty feature list with no features message', () => {
    const output = {
      features: [],
      totalCount: 0,
      region: '1:1-100',
      species: 'homo_sapiens',
    };
    const blocks = ensemblQueryRegion.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('No features found');
  });

  it('formats variation feature with clinicalSignificance', () => {
    const varFeature: OverlapFeature = {
      id: 'rs12345',
      featureType: 'variation',
      chromosome: '13',
      start: 32315100,
      end: 32315100,
      consequenceType: 'missense_variant',
      clinicalSignificance: ['pathogenic', 'likely_pathogenic'],
    };
    const output = {
      features: [varFeature],
      totalCount: 1,
      region: '13:32315086-32400268',
      species: 'homo_sapiens',
    };
    const blocks = ensemblQueryRegion.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('pathogenic');
    expect(text).toContain('missense_variant');
  });
});
