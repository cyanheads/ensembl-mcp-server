/**
 * @fileoverview Tests for the ensembl_lookup_gene tool.
 * @module tests/tools/lookup-gene.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblLookupGene } from '@/mcp-server/tools/definitions/lookup-gene.tool.js';
import type { GeneRecord } from '@/services/ensembl/types.js';

const mockLookupGene = vi.fn();
const mockLookupGeneById = vi.fn();
const mockLookupGenesBatch = vi.fn();
const mockLookupSymbolsBatch = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    lookupGene: mockLookupGene,
    lookupGeneById: mockLookupGeneById,
    lookupGenesBatch: mockLookupGenesBatch,
    lookupSymbolsBatch: mockLookupSymbolsBatch,
  }),
}));

const brca2Gene: GeneRecord = {
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
};

const brca2WithTranscripts: GeneRecord = {
  ...brca2Gene,
  transcripts: [
    {
      id: 'ENST00000380152',
      displayName: 'BRCA2-201',
      biotype: 'protein_coding',
      isCanonical: true,
      start: 32315086,
      end: 32400268,
      strand: 1,
      lengthInBp: 10257,
    },
    {
      id: 'ENST00000544455',
      displayName: 'BRCA2-202',
      biotype: 'protein_coding',
      isCanonical: false,
      start: 32316422,
      end: 32399672,
      strand: 1,
      lengthInBp: 8713,
    },
  ],
};

describe('ensemblLookupGene', () => {
  it('resolves a gene by symbol + species', async () => {
    mockLookupGene.mockResolvedValueOnce(brca2Gene);
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({ symbol: 'BRCA2', species: 'homo_sapiens' });
    const result = await ensemblLookupGene.handler(input, ctx);
    expect(result.gene).toBeDefined();
    expect(result.gene!.id).toBe('ENSG00000139618');
    expect(result.gene!.displayName).toBe('BRCA2');
    expect(result.gene!.chromosome).toBe('13');
    expect(result.batch).toBeUndefined();
  });

  it('defaults species to homo_sapiens when symbol provided without species', async () => {
    mockLookupGene.mockResolvedValueOnce(brca2Gene);
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({ symbol: 'TP53' });
    const result = await ensemblLookupGene.handler(input, ctx);
    expect(result.gene).toBeDefined();
  });

  it('resolves a gene by stable ID', async () => {
    mockLookupGeneById.mockResolvedValueOnce(brca2Gene);
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({ id: 'ENSG00000139618' });
    const result = await ensemblLookupGene.handler(input, ctx);
    expect(result.gene).toBeDefined();
    expect(result.gene!.id).toBe('ENSG00000139618');
  });

  it('batch lookup by ids returns succeeded/failed split', async () => {
    mockLookupGenesBatch.mockResolvedValueOnce(new Map([['ENSG00000139618', brca2Gene]]));
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({
      ids: ['ENSG00000139618', 'ENSG99999999999'],
    });
    const result = await ensemblLookupGene.handler(input, ctx);
    expect(result.batch).toBeDefined();
    expect(result.batch!.succeeded).toHaveLength(1);
    expect(result.batch!.failed).toHaveLength(1);
    expect((result.batch!.failed[0] as { query: string }).query).toBe('ENSG99999999999');
  });

  it('batch lookup by symbols returns succeeded/failed split', async () => {
    mockLookupSymbolsBatch.mockResolvedValueOnce(new Map([['BRCA2', brca2Gene]]));
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({
      symbols: ['BRCA2', 'NONEXISTENT_GENE'],
      species: 'homo_sapiens',
    });
    const result = await ensemblLookupGene.handler(input, ctx);
    expect(result.batch).toBeDefined();
    expect(result.batch!.succeeded).toHaveLength(1);
    expect(result.batch!.failed).toHaveLength(1);
  });

  it('throws not_found when symbol lookup fails with "not found" message', async () => {
    mockLookupGene.mockRejectedValueOnce(new Error('not found in Ensembl'));
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({ symbol: 'FAKEGENE', species: 'homo_sapiens' });
    await expect(ensemblLookupGene.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws invalid_species when species string is unrecognized', async () => {
    mockLookupGene.mockRejectedValueOnce(new Error('species unrecognized'));
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({ symbol: 'BRCA2', species: 'not_a_species' });
    await expect(ensemblLookupGene.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_species' },
    });
  });

  it('throws no_input when neither symbol, id, ids, nor symbols is provided', async () => {
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({});
    await expect(ensemblLookupGene.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_input' },
    });
  });

  it('formats single gene result with all fields', () => {
    const output = { gene: brca2Gene };
    const blocks = ensemblLookupGene.format!(output);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('BRCA2');
    expect(text).toContain('ENSG00000139618');
    expect(text).toContain('13');
    expect(text).toContain('GRCh38');
  });

  it('formats gene result with transcripts when expand_transcripts=true', () => {
    const blocks = ensemblLookupGene.format!({ gene: brca2WithTranscripts });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENST00000380152');
    expect(text).toContain('canonical');
    expect(text).toContain('ENST00000544455');
  });

  it('formats batch result with succeeded and failed entries', () => {
    const output = {
      batch: {
        succeeded: [brca2Gene],
        failed: [{ query: 'ENSG99999999999', error: 'ID ENSG99999999999 not found in Ensembl.' }],
      },
    };
    const blocks = ensemblLookupGene.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Batch Lookup Results');
    expect(text).toContain('ENSG00000139618');
    expect(text).toContain('ENSG99999999999');
    expect(text).toContain('Failed lookups');
  });

  it('formats sparse gene (only id, no optional fields) without crash', () => {
    const sparseGene: GeneRecord = { id: 'ENSG00000000001' };
    const blocks = ensemblLookupGene.format!({ gene: sparseGene });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENSG00000000001');
  });
});
