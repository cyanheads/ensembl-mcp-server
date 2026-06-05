/**
 * @fileoverview Tests for the ensembl_get_homology tool.
 * @module tests/tools/get-homology.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('ensemblGetHomology', () => {
  it('finds orthologs by gene symbol', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce([mouseOrtholog, ratOrtholog]);
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ symbol: 'BRCA2', species: 'homo_sapiens' });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.homologs).toHaveLength(2);
    expect(result.totalCount).toBe(2);
    expect(result.queryId).toBe('BRCA2');
    expect(result.querySpecies).toBe('homo_sapiens');
    expect(result.queryType).toBe('orthologues');
  });

  it('finds orthologs by stable gene ID', async () => {
    mockGetHomologyById.mockResolvedValueOnce([mouseOrtholog]);
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({ id: 'ENSG00000139618' });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.homologs).toHaveLength(1);
    expect(result.queryId).toBe('ENSG00000139618');
    // Verify species is forwarded to the service (required for correct API URL)
    expect(mockGetHomologyById).toHaveBeenCalledWith(
      'ENSG00000139618',
      'homo_sapiens',
      expect.any(String),
      undefined,
      expect.anything(),
    );
  });

  it('includes perc_id and perc_pos in ortholog results', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce([mouseOrtholog, ratOrtholog]);
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

  it('returns empty list when no homologs found', async () => {
    mockGetHomologyBySymbol.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblGetHomology.errors });
    const input = ensemblGetHomology.input.parse({
      symbol: 'BRCA2',
      target_species: 'caenorhabditis_elegans',
    });
    const result = await ensemblGetHomology.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.homologs).toHaveLength(0);
  });

  it('formats homology results with perc_id and perc_pos', () => {
    const output = {
      homologs: [mouseOrtholog, ratOrtholog],
      totalCount: 2,
      queryId: 'BRCA2',
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
      queryId: 'BRCA2',
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
      queryId: 'BRCA2',
      querySpecies: 'homo_sapiens',
      queryType: 'orthologues',
    };
    const blocks = ensemblGetHomology.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENSORG00000001234');
    expect(text).not.toContain('undefined');
  });
});
