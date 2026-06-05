/**
 * @fileoverview Tests for the ensembl_predict_variant tool.
 * @module tests/tools/predict-variant.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import type { VepRecord } from '@/services/ensembl/types.js';

const mockPredictVariantHgvs = vi.fn();
const mockPredictVariantRegion = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    predictVariantHgvs: mockPredictVariantHgvs,
    predictVariantRegion: mockPredictVariantRegion,
  }),
}));

const missenseResult: VepRecord = {
  input: 'ENST00000380152.8:c.2T>A',
  chromosome: '13',
  start: 32316462,
  end: 32316462,
  assemblyName: 'GRCh38',
  mostSevereConsequence: 'missense_variant',
  transcriptConsequences: [
    {
      transcriptId: 'ENST00000380152',
      geneId: 'ENSG00000139618',
      geneSymbol: 'BRCA2',
      consequenceTerms: ['missense_variant'],
      impact: 'MODERATE',
      biotype: 'protein_coding',
      hgvsc: 'ENST00000380152.8:c.2T>A',
      hgvsp: 'ENSP00000369497.3:p.Met1Thr',
      aminoAcids: 'M/T',
      sift: { prediction: 'deleterious', score: 0.01 },
      polyphen: { prediction: 'probably_damaging', score: 0.998 },
    },
  ],
  colocatedVariants: [
    {
      id: 'rs1799950',
      alleleString: 'T/A',
      clinicalSignificance: ['pathogenic'],
      pubmed: [12345678],
    },
  ],
};

const regionResult: VepRecord = {
  input: '1:65568:65568:1/T',
  chromosome: '1',
  start: 65568,
  end: 65568,
  mostSevereConsequence: 'synonymous_variant',
  transcriptConsequences: [
    {
      transcriptId: 'ENST00000641515',
      geneId: 'ENSG00000186092',
      geneSymbol: 'OR4F5',
      consequenceTerms: ['synonymous_variant'],
      impact: 'LOW',
    },
  ],
  colocatedVariants: [],
};

describe('ensemblPredictVariant', () => {
  it('processes HGVS notation via predictVariantHgvs', async () => {
    mockPredictVariantHgvs.mockResolvedValueOnce([missenseResult]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({
      variant: 'ENST00000380152.8:c.2T>A',
    });
    const result = await ensemblPredictVariant.handler(input, ctx);
    expect(result.results).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.results[0]!.mostSevereConsequence).toBe('missense_variant');
  });

  it('processes region+allele format via predictVariantRegion', async () => {
    mockPredictVariantRegion.mockResolvedValueOnce([regionResult]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({
      variant: '1:65568:65568:1/T',
    });
    const result = await ensemblPredictVariant.handler(input, ctx);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.mostSevereConsequence).toBe('synonymous_variant');
    expect(mockPredictVariantRegion).toHaveBeenCalledWith(
      '1',
      65568,
      65568,
      1,
      'T',
      'homo_sapiens',
      expect.anything(),
    );
  });

  it('defaults species to homo_sapiens', () => {
    const input = ensemblPredictVariant.input.parse({ variant: '13:g.32316462T>A' });
    expect(input.species).toBe('homo_sapiens');
  });

  it('throws invalid_notation on malformed HGVS', async () => {
    mockPredictVariantHgvs.mockRejectedValueOnce(
      new Error('invalid HGVS notation malformed input'),
    );
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: 'BAD_NOTATION' });
    await expect(ensemblPredictVariant.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_notation' },
    });
  });

  it('throws not_found when variant position is outside known regions', async () => {
    mockPredictVariantHgvs.mockRejectedValueOnce(new Error('not found outside annotated region'));
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: '99:g.1T>A' });
    await expect(ensemblPredictVariant.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('returns empty results when VEP returns nothing', async () => {
    mockPredictVariantHgvs.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: '1:g.1A>T' });
    const result = await ensemblPredictVariant.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('formats VEP result with consequence, impact, SIFT, PolyPhen, and colocated variants', () => {
    const output = { results: [missenseResult], totalCount: 1 };
    const blocks = ensemblPredictVariant.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('missense_variant');
    expect(text).toContain('MODERATE');
    expect(text).toContain('BRCA2');
    expect(text).toContain('ENSG00000139618');
    expect(text).toContain('rs1799950');
    expect(text).toContain('pathogenic');
    expect(text).toContain('SIFT');
    expect(text).toContain('PolyPhen');
    expect(text).toContain('12345678');
  });

  it('formats empty VEP results gracefully', () => {
    const blocks = ensemblPredictVariant.format!({ results: [], totalCount: 0 });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('No VEP results');
  });

  it('formats region+allele result', () => {
    const output = { results: [regionResult], totalCount: 1 };
    const blocks = ensemblPredictVariant.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('synonymous_variant');
    expect(text).toContain('OR4F5');
  });

  it('formats sparse VEP result (minimal fields) without crash', () => {
    const sparseResult: VepRecord = {
      transcriptConsequences: [],
      colocatedVariants: [],
    };
    const blocks = ensemblPredictVariant.format!({ results: [sparseResult], totalCount: 1 });
    expect(blocks[0]!.type).toBe('text');
  });
});
