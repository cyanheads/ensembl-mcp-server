/**
 * @fileoverview Tests for the ensembl_get_homology tool.
 * @module tests/tools/get-homology.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGetHomology } from '@/mcp-server/tools/definitions/get-homology.tool.js';
import type { HomologyEntry } from '@/services/ensembl/types.js';

const mockGetHomologyBySymbol = vi.fn();
const mockGetHomologyById = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    getHomologyBySymbol: mockGetHomologyBySymbol,
    getHomologyById: mockGetHomologyById,
  }),
}));

const mouseOrtholog: HomologyEntry = {
  targetId: 'ENSMUSG00000041147',
  targetSpecies: 'mus_musculus',
  type: 'ortholog_one2one',
  percId: 94.7,
  percPos: 96.2,
  taxonomyLevel: 'Amniota',
};

const ratOrtholog: HomologyEntry = {
  targetId: 'ENSRNOG00000023990',
  targetSpecies: 'rattus_norvegicus',
  type: 'ortholog_one2one',
  percId: 91.3,
  percPos: 93.8,
  taxonomyLevel: 'Amniota',
};

const BRCA2_ID = 'ENSG00000139618';
const TP53_ID = 'ENSG00000141510';

// 174 homologs, mirroring the BRCA2-orthologues field-test evidence (issue #15).
const manyHomologs: HomologyEntry[] = Array.from({ length: 174 }, (_, i) => ({
  targetId: `ENSORG${String(i).padStart(11, '0')}`,
  targetSpecies: `species_${i}`,
  type: 'ortholog_one2one',
  percId: 90,
  percPos: 92,
  taxonomyLevel: 'Vertebrata',
}));

describe('ensemblGetHomology', () => {
  it('finds orthologs by gene symbol and returns the resolved stable ID as queryId', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce({
      homologs: [mouseOrtholog, ratOrtholog],
      resolvedQueryId: BRCA2_ID,
    });
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2', species: 'homo_sapiens' });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.homologs).toHaveLength(2);
    expect(result.totalCount).toBe(2);
    // #6: queryId is the resolved Ensembl stable ID, not the submitted symbol.
    expect(result.queryId).toBe(BRCA2_ID);
    expect(result.querySpecies).toBe('homo_sapiens');
    expect(result.queryType).toBe('orthologues');
  });

  it('resolves a symbol query to a stable queryId, not the echoed symbol (#6 regression)', async () => {
    // Mirrors the issue repro: TP53 symbol mode must surface ENSG00000141510.
    mockGetHomologyBySymbol.mockResolvedValueOnce({
      homologs: [mouseOrtholog],
      resolvedQueryId: TP53_ID,
    });
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({
      symbol: 'TP53',
      species: 'homo_sapiens',
      target_species: 'mus_musculus',
    });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.queryId).toBe(TP53_ID);
    expect(result.queryId).not.toBe('TP53');
  });

  it('falls back to the submitted symbol when no query id resolves', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce({ homologs: [mouseOrtholog] });
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2', species: 'homo_sapiens' });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.queryId).toBe('BRCA2');
  });

  it('finds orthologs by stable gene ID', async () => {
    mockGetHomologyById.mockResolvedValueOnce({
      homologs: [mouseOrtholog],
      resolvedQueryId: BRCA2_ID,
    });
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ id: BRCA2_ID });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.homologs).toHaveLength(1);
    expect(result.queryId).toBe(BRCA2_ID);
    // Verify species is forwarded to the service (required for correct API URL)
    expect(mockGetHomologyById).toHaveBeenCalledWith(
      BRCA2_ID,
      'homo_sapiens',
      expect.any(String),
      undefined,
      expect.anything(),
    );
  });

  it('includes perc_id and perc_pos in ortholog results', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce({
      homologs: [mouseOrtholog, ratOrtholog],
      resolvedQueryId: BRCA2_ID,
    });
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2' });
    const result = await ensemblGetHomology.handler(input, ctx);
    const mouse = result.homologs.find((h) => h.targetSpecies === 'mus_musculus');
    expect(mouse).toBeDefined();
    expect(mouse!.percId).toBe(94.7);
    expect(mouse!.percPos).toBe(96.2);
    expect(mouse!.type).toBe('ortholog_one2one');
    expect(mouse!.taxonomyLevel).toBe('Amniota');
  });

  it('defaults species to homo_sapiens and type to orthologues', () => {
    const input = ensemblGetHomology.input.parse({ symbol: 'TP53' });
    expect(input.species).toBe('homo_sapiens');
    expect(input.type).toBe('orthologues');
  });

  it('throws no_input when neither symbol nor id is provided', async () => {
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({});
    await expect(ensemblGetHomology.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_input' },
    });
  });

  it('throws conflicting_input when both symbol and id are provided', async () => {
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({
      id: BRCA2_ID,
      symbol: 'TP53',
      species: 'homo_sapiens',
    });
    await expect(ensemblGetHomology.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_input' },
    });
  });

  it('throws not_found when gene is unknown', async () => {
    mockGetHomologyBySymbol.mockRejectedValueOnce(new Error('Gene not found in Ensembl'));
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'FAKEGENE' });
    await expect(ensemblGetHomology.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when Ensembl returns species name as error (invalid symbol behavior)', async () => {
    // Ensembl homology/symbol returns {"error":"homo_sapiens"} for invalid gene symbols
    mockGetHomologyBySymbol.mockRejectedValueOnce(new Error('homo_sapiens'));
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'FAKEGENE', species: 'homo_sapiens' });
    await expect(ensemblGetHomology.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('returns empty list when no homologs found but still surfaces the resolved queryId', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce({ homologs: [], resolvedQueryId: BRCA2_ID });
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({
      symbol: 'BRCA2',
      target_species: 'caenorhabditis_elegans',
    });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.homologs).toHaveLength(0);
    expect(result.queryId).toBe(BRCA2_ID);
  });

  it('formats homology results with perc_id and perc_pos', () => {
    const output = {
      homologs: [mouseOrtholog, ratOrtholog],
      totalCount: 2,
      queryId: BRCA2_ID,
      querySpecies: 'homo_sapiens',
      queryType: 'orthologues',
    };
    const blocks = ensemblGetHomology.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENSMUSG00000041147');
    expect(text).toContain('mus_musculus');
    expect(text).toContain('94.7%');
    expect(text).toContain('96.2%');
    expect(text).toContain('Amniota');
    expect(text).toContain('ortholog_one2one');
  });

  it('formats empty homology results with guidance', () => {
    const output = {
      homologs: [],
      totalCount: 0,
      queryId: BRCA2_ID,
      querySpecies: 'homo_sapiens',
      queryType: 'orthologues',
    };
    const blocks = ensemblGetHomology.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('No homologs found');
    expect(text).toContain('type=all');
  });

  it('formats sparse homology entry (only targetId) without crash', () => {
    const sparseHomolog: HomologyEntry = { targetId: 'ENSORG00000001234' };
    const output = {
      homologs: [sparseHomolog],
      totalCount: 1,
      queryId: BRCA2_ID,
      querySpecies: 'homo_sapiens',
      queryType: 'orthologues',
    };
    const blocks = ensemblGetHomology.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENSORG00000001234');
    expect(text).not.toContain('undefined');
  });

  describe('result shaping (issue #15)', () => {
    it('caps homologs to the default (25) but keeps totalCount at the true available count', async () => {
      mockGetHomologyBySymbol.mockResolvedValueOnce({
        homologs: manyHomologs,
        resolvedQueryId: BRCA2_ID,
      });
      const ctx = createMockContext({ errors: ensemblGetHomology.errors });
      const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2', species: 'homo_sapiens' });
      const result = await ensemblGetHomology.handler(input, ctx);
      expect(result.homologs).toHaveLength(25);
      // totalCount reports the full available count, not the capped page length.
      expect(result.totalCount).toBe(174);
    });

    it('returns every homolog when max_results is 0', async () => {
      mockGetHomologyBySymbol.mockResolvedValueOnce({
        homologs: manyHomologs,
        resolvedQueryId: BRCA2_ID,
      });
      const ctx = createMockContext({ errors: ensemblGetHomology.errors });
      const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2', max_results: 0 });
      const result = await ensemblGetHomology.handler(input, ctx);
      expect(result.homologs).toHaveLength(174);
      expect(result.totalCount).toBe(174);
    });

    it('emits a truncation notice reporting shown-of-total when capped', async () => {
      mockGetHomologyBySymbol.mockResolvedValueOnce({
        homologs: manyHomologs,
        resolvedQueryId: BRCA2_ID,
      });
      const ctx = createMockContext({ errors: ensemblGetHomology.errors });
      const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2' });
      await ensemblGetHomology.handler(input, ctx);
      const { notice, truncated, shown, cap } = getEnrichment(ctx) as {
        notice?: string;
        truncated?: boolean;
        shown?: number;
        cap?: number;
      };
      expect(notice).toContain('25 of 174 homologs');
      expect(truncated).toBe(true);
      expect(shown).toBe(25);
      expect(cap).toBe(25);
    });

    it('does not truncate when the available set is within max_results', async () => {
      mockGetHomologyBySymbol.mockResolvedValueOnce({
        homologs: [mouseOrtholog, ratOrtholog],
        resolvedQueryId: BRCA2_ID,
      });
      const ctx = createMockContext({ errors: ensemblGetHomology.errors });
      const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2' });
      const result = await ensemblGetHomology.handler(input, ctx);
      expect(result.homologs).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      const { truncated } = getEnrichment(ctx) as { truncated?: boolean };
      expect(truncated).toBeUndefined();
    });

    it('renders shown-of-total in the text output when capped', () => {
      const output = {
        homologs: manyHomologs.slice(0, 25),
        totalCount: 174,
        queryId: BRCA2_ID,
        querySpecies: 'homo_sapiens',
        queryType: 'orthologues',
      };
      const text = (ensemblGetHomology.format!(output)[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('25 of 174');
    });
  });

  it('surfaces the declared recovery hint on a not_found error (issue #16)', async () => {
    mockGetHomologyBySymbol.mockRejectedValueOnce(new Error('Gene not found in Ensembl'));
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'FAKEGENE' });
    await expect(ensemblGetHomology.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: {
          hint: ensemblGetHomology.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });
});
