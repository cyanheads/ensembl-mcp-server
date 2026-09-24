/**
 * @fileoverview Tests for the ensembl_predict_variant tool.
 * @module tests/tools/predict-variant.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import type { VepRecord } from '@/services/ensembl/types.js';

const mockPredictVariantHgvs = vi.fn();
const mockPredictVariantRegion = vi.fn();
const mockPredictVariantId = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    predictVariantHgvs: mockPredictVariantHgvs,
    predictVariantRegion: mockPredictVariantRegion,
    predictVariantId: mockPredictVariantId,
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

// Mirrors the live /vep/homo_sapiens/id/rs334 response shape (HBB / missense / MODERATE).
const rsIdResult: VepRecord = {
  input: 'rs334',
  chromosome: '11',
  start: 5227002,
  end: 5227002,
  assemblyName: 'GRCh38',
  mostSevereConsequence: 'missense_variant',
  transcriptConsequences: [
    {
      transcriptId: 'ENST00000335295',
      geneId: 'ENSG00000244734',
      geneSymbol: 'HBB',
      consequenceTerms: ['missense_variant'],
      impact: 'MODERATE',
      biotype: 'protein_coding',
      aminoAcids: 'E/V',
    },
  ],
  colocatedVariants: [{ id: 'rs334', alleleString: 'T/A' }],
};

// High-cardinality record mirroring the rs334 field-test evidence: 66 transcript
// consequences and one colocated variant carrying 119 PubMed IDs (issue #15).
const highCardinalityResult: VepRecord = {
  input: 'rs334',
  chromosome: '11',
  start: 5227002,
  end: 5227002,
  assemblyName: 'GRCh38',
  mostSevereConsequence: 'missense_variant',
  transcriptConsequences: Array.from({ length: 66 }, (_, i) => ({
    transcriptId: `ENST00000${300000 + i}`,
    geneId: 'ENSG00000244734',
    geneSymbol: 'HBB',
    consequenceTerms: ['missense_variant'],
    impact: 'MODERATE',
  })),
  colocatedVariants: [
    {
      id: 'rs334',
      alleleString: 'T/A',
      pubmed: Array.from({ length: 119 }, (_, i) => 1000 + i),
    },
  ],
};

describe('ensemblPredictVariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('routes a dbSNP rsID to predictVariantId (issue #11)', async () => {
    mockPredictVariantId.mockResolvedValueOnce([rsIdResult]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: 'rs334' });
    const result = await ensemblPredictVariant.handler(input, ctx);
    expect(mockPredictVariantId).toHaveBeenCalledWith('rs334', 'homo_sapiens', expect.anything());
    // An rsID must not be misrouted to the HGVS or region endpoints.
    expect(mockPredictVariantHgvs).not.toHaveBeenCalled();
    expect(mockPredictVariantRegion).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    const tc = result.results[0]!.transcriptConsequences[0]!;
    expect(tc.geneSymbol).toBe('HBB');
    expect(tc.consequenceTerms).toContain('missense_variant');
    expect(tc.impact).toBe('MODERATE');
  });

  it('routes uppercase RS-prefixed identifiers to predictVariantId (issue #11)', async () => {
    mockPredictVariantId.mockResolvedValueOnce([rsIdResult]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: 'RS334' });
    await ensemblPredictVariant.handler(input, ctx);
    expect(mockPredictVariantId).toHaveBeenCalledWith('RS334', 'homo_sapiens', expect.anything());
  });

  it('keeps HGVS input on the HGVS endpoint, not the rsID endpoint (issue #11 routing)', async () => {
    mockPredictVariantHgvs.mockResolvedValueOnce([missenseResult]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    await ensemblPredictVariant.handler(
      ensemblPredictVariant.input.parse({ variant: 'ENST00000380152.8:c.2T>A' }),
      ctx,
    );
    expect(mockPredictVariantHgvs).toHaveBeenCalledTimes(1);
    expect(mockPredictVariantId).not.toHaveBeenCalled();
  });

  it('throws not_found for an unknown rsID (issue #11)', async () => {
    mockPredictVariantId.mockRejectedValueOnce(
      new Error("No variant found with ID 'rs99999999999'"),
    );
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: 'rs99999999999' });
    await expect(ensemblPredictVariant.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
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

  describe('result shaping (issue #15)', () => {
    it('caps transcript consequences to the default (10) and reports the true total', async () => {
      mockPredictVariantId.mockResolvedValueOnce([highCardinalityResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({ variant: 'rs334' });
      const result = await ensemblPredictVariant.handler(input, ctx);
      expect(result.results[0]!.transcriptConsequences).toHaveLength(10);
      expect(result.results[0]!.transcriptConsequencesTotal).toBe(66);
    });

    it('returns every transcript consequence when max_transcript_consequences is 0', async () => {
      mockPredictVariantId.mockResolvedValueOnce([highCardinalityResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({
        variant: 'rs334',
        max_transcript_consequences: 0,
      });
      const result = await ensemblPredictVariant.handler(input, ctx);
      expect(result.results[0]!.transcriptConsequences).toHaveLength(66);
      expect(result.results[0]!.transcriptConsequencesTotal).toBe(66);
    });

    it('caps colocated PubMed IDs to the default (10) and reports the true pubmedTotal', async () => {
      mockPredictVariantId.mockResolvedValueOnce([highCardinalityResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({ variant: 'rs334' });
      const result = await ensemblPredictVariant.handler(input, ctx);
      const cv = result.results[0]!.colocatedVariants[0]!;
      expect(cv.pubmed).toHaveLength(10);
      expect(cv.pubmedTotal).toBe(119);
    });

    it('returns every PubMed ID when include_all_colocated_pubmed is true', async () => {
      mockPredictVariantId.mockResolvedValueOnce([highCardinalityResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({
        variant: 'rs334',
        include_all_colocated_pubmed: true,
      });
      const result = await ensemblPredictVariant.handler(input, ctx);
      expect(result.results[0]!.colocatedVariants[0]!.pubmed).toHaveLength(119);
    });

    it('returns every PubMed ID when max_pubmed_ids_per_variant is 0', async () => {
      mockPredictVariantId.mockResolvedValueOnce([highCardinalityResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({
        variant: 'rs334',
        max_pubmed_ids_per_variant: 0,
      });
      const result = await ensemblPredictVariant.handler(input, ctx);
      expect(result.results[0]!.colocatedVariants[0]!.pubmed).toHaveLength(119);
    });

    it('composes both cap disclosures into a single notice when both trip', async () => {
      mockPredictVariantId.mockResolvedValueOnce([highCardinalityResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({ variant: 'rs334' });
      await ensemblPredictVariant.handler(input, ctx);
      const { notice, truncated, shown, cap } = getEnrichment(ctx) as {
        notice?: string;
        truncated?: boolean;
        shown?: number;
        cap?: number;
      };
      // One notice carries both fragments (ctx.enrich.notice is last-wins).
      expect(notice).toContain('10 of 66 transcript consequences');
      expect(notice).toContain('capped PubMed IDs to 10');
      expect(truncated).toBe(true);
      expect(shown).toBe(10);
      expect(cap).toBe(10);
    });

    it('emits no truncation notice when nothing is capped', async () => {
      mockPredictVariantHgvs.mockResolvedValueOnce([missenseResult]);
      const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
      const input = ensemblPredictVariant.input.parse({ variant: 'ENST00000380152.8:c.2T>A' });
      await ensemblPredictVariant.handler(input, ctx);
      const { truncated, notice } = getEnrichment(ctx) as {
        truncated?: boolean;
        notice?: string;
      };
      expect(truncated).toBeUndefined();
      expect(notice).toBeUndefined();
    });

    it('renders shown-of-total counts in the text output', () => {
      const output = {
        results: [
          {
            ...highCardinalityResult,
            transcriptConsequences: highCardinalityResult.transcriptConsequences.slice(0, 10),
            transcriptConsequencesTotal: 66,
            colocatedVariants: [
              {
                ...highCardinalityResult.colocatedVariants[0]!,
                pubmed: highCardinalityResult.colocatedVariants[0]!.pubmed!.slice(0, 10),
                pubmedTotal: 119,
              },
            ],
          },
        ],
        totalCount: 1,
      };
      const text = (ensemblPredictVariant.format!(output)[0] as { type: 'text'; text: string })
        .text;
      expect(text).toContain('Transcript consequences (10 of 66)');
      expect(text).toContain('showing 10 of 119');
    });
  });

  it('surfaces the declared recovery hint on a not_found error (issue #16)', async () => {
    mockPredictVariantId.mockRejectedValueOnce(
      new Error("No variant found with ID 'rs99999999999'"),
    );
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    const input = ensemblPredictVariant.input.parse({ variant: 'rs99999999999' });
    await expect(ensemblPredictVariant.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: {
          hint: ensemblPredictVariant.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });
});

describe('ensemblPredictVariant blank identifiers (issue #22)', () => {
  const calls = () =>
    mockPredictVariantHgvs.mock.calls.length +
    mockPredictVariantRegion.mock.calls.length +
    mockPredictVariantId.mock.calls.length;

  it.each([
    ['variant', { variant: '' }],
    ['variant', { variant: '   ' }],
    ['species', { variant: 'rs334', species: '' }],
    ['species', { variant: 'rs334', species: '  ' }],
  ])('rejects a blank %s as invalid_arguments before any request', async (_field, args) => {
    mockPredictVariantHgvs.mockClear();
    mockPredictVariantRegion.mockClear();
    mockPredictVariantId.mockClear();
    const result = await runToolContract(ensemblPredictVariant, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(calls()).toBe(0);
  });

  it('still defaults an omitted species to homo_sapiens', () => {
    expect(ensemblPredictVariant.input.parse({ variant: 'rs334' }).species).toBe('homo_sapiens');
  });
});
