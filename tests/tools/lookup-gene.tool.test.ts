/**
 * @fileoverview Tests for the ensembl_lookup_gene tool.
 * @module tests/tools/lookup-gene.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblLookupGene } from '@/mcp-server/tools/definitions/lookup-gene.tool.js';
import type { GeneRecord } from '@/services/ensembl/types.js';

const mockLookupGene = vi.fn();
const mockLookupGeneById = vi.fn();
const mockLookupGenesBatch = vi.fn();
const mockLookupSymbolsBatch = vi.fn();
const mockResolveSymbolAliases = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    lookupGene: mockLookupGene,
    lookupGeneById: mockLookupGeneById,
    lookupGenesBatch: mockLookupGenesBatch,
    lookupSymbolsBatch: mockLookupSymbolsBatch,
    resolveSymbolAliases: mockResolveSymbolAliases,
  }),
}));

const notFoundRecovery = ensemblLookupGene.errors!.find((e) => e.reason === 'not_found')!.recovery;

const erbb2Gene: GeneRecord = { id: 'ENSG00000141736', displayName: 'ERBB2', chromosome: '17' };
const abcb1Gene: GeneRecord = { id: 'ENSG00000085563', displayName: 'ABCB1', chromosome: '7' };
const tbc1d9Gene: GeneRecord = { id: 'ENSG00000109436', displayName: 'TBC1D9', chromosome: '4' };

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

  it('passes a non-species upstream failure from the alias fallback through unchanged', async () => {
    mockLookupSymbolsBatch.mockResolvedValueOnce(new Map());
    mockResolveSymbolAliases.mockRejectedValueOnce(new Error('Ensembl API returned HTTP 503.'));
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    await expect(
      ensemblLookupGene.handler(ensemblLookupGene.input.parse({ symbols: ['A1'] }), ctx),
    ).rejects.toThrow('Ensembl API returned HTTP 503.');
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

  it('throws conflicting_input when more than one of symbol/id/ids/symbols is provided', async () => {
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    const input = ensemblLookupGene.input.parse({ symbol: 'TP53', id: 'ENSG00000139618' });
    await expect(ensemblLookupGene.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_input' },
    });
  });

  it('surfaces the declared recovery hint on a not_found error (issue #16)', async () => {
    mockLookupGene.mockRejectedValueOnce(new Error('not found in Ensembl'));
    const result = await runToolContract(ensemblLookupGene, {
      symbol: 'FAKEGENE',
      species: 'homo_sapiens',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'not_found',
          recovery: {
            hint: ensemblLookupGene.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
        },
      },
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
        succeeded: [{ query: 'ENSG00000139618', ...brca2Gene }],
        failed: [
          {
            query: 'ENSG99999999999',
            reason: 'not_found' as const,
            error: 'ID ENSG99999999999 not found in Ensembl.',
            recovery: notFoundRecovery,
          },
        ],
      },
    };
    const blocks = ensemblLookupGene.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Batch Lookup Results');
    expect(text).toContain('ENSG00000139618');
    expect(text).toContain('Failed lookups');
    expect(text).toContain(
      '- **ENSG99999999999** (not_found): ID ENSG99999999999 not found in Ensembl.',
    );
    expect(text).toContain(notFoundRecovery);
  });

  it('formats each failed item and each distinct recovery once (issue #18)', () => {
    const missing = (query: string) => ({
      query,
      reason: 'not_found' as const,
      error: `Symbol ${query} not found in Ensembl for species homo_sapiens.`,
      recovery: notFoundRecovery,
    });
    const text = (
      ensemblLookupGene.format!({
        batch: {
          succeeded: [{ query: 'her2', ...erbb2Gene, matchedAlias: 'her2' }],
          failed: [
            missing('NOPE_A'),
            {
              query: 'MDR1',
              reason: 'ambiguous',
              error: 'Symbol MDR1 maps to 2 genes in homo_sapiens.',
              recovery: 'Retry with id set to ENSG00000085563 or ENSG00000109436.',
              candidates: [abcb1Gene, tbc1d9Gene],
            },
            missing('NOPE_B'),
          ],
        },
      })[0] as { type: 'text'; text: string }
    ).text;
    expect(text).toContain('**Query:** her2');
    expect(text).toContain('**Matched alias:** her2');
    expect(text).toContain('- **NOPE_A** (not_found)');
    expect(text).toContain('- **NOPE_B** (not_found)');
    expect(text).toContain('- **MDR1** (ambiguous): Symbol MDR1 maps to 2 genes');
    expect(text).toContain('#### TBC1D9');
    expect(text.split(notFoundRecovery)).toHaveLength(2);
    expect(text).toContain('Retry with id set to ENSG00000085563 or ENSG00000109436.');
  });

  it('advertises concrete batch item and ambiguity fields in the output schema (issue #18)', () => {
    type Node = { properties?: Record<string, Node>; items?: Node };
    const schema = z.toJSONSchema(ensemblLookupGene.output) as Node;
    const batch = schema.properties!.batch!.properties!;
    expect(Object.keys(batch.succeeded!.items!.properties!)).toEqual(
      expect.arrayContaining(['query', 'id', 'displayName', 'matchedAlias', 'chromosome']),
    );
    expect(Object.keys(batch.failed!.items!.properties!)).toEqual(
      expect.arrayContaining(['query', 'reason', 'error', 'recovery', 'candidates']),
    );
    expect(Object.keys(schema.properties!.ambiguous!.properties!)).toEqual([
      'query',
      'candidates',
      'guidance',
    ]);
  });

  it('formats sparse gene (only id, no optional fields) without crash', () => {
    const sparseGene: GeneRecord = { id: 'ENSG00000000001' };
    const blocks = ensemblLookupGene.format!({ gene: sparseGene });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENSG00000000001');
  });
});

describe('ensemblLookupGene blank batch entries (issue #22)', () => {
  it.each([
    ['ids', { ids: ['ENSG00000139618', ''] }],
    ['ids', { ids: ['   '] }],
    ['symbols', { symbols: ['BRCA2', ' '] }],
    ['symbols', { symbols: [''] }],
  ])('rejects a blank %s entry as invalid_arguments before any request', async (_field, args) => {
    mockLookupGenesBatch.mockClear();
    mockLookupSymbolsBatch.mockClear();
    const result = await runToolContract(ensemblLookupGene, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(mockLookupGenesBatch).not.toHaveBeenCalled();
    expect(mockLookupSymbolsBatch).not.toHaveBeenCalled();
  });
});

describe('ensemblLookupGene upstream-message classification cost (issues #18, #20)', () => {
  /** Near-misses of every pattern the handler tests, echoing a caller-sized symbol. */
  const nearMiss = (chars: number) =>
    'No valid lookup found for symbo Can not find internal name for specie '
      .repeat(Math.ceil(chars / 70))
      .slice(0, chars);

  /** Thread CPU microseconds for one handler run whose upstream call rejects with `message`. */
  async function classifyCpu(mode: 'symbol' | 'symbols', message: string): Promise<number> {
    const ctx = createMockContext({ errors: ensemblLookupGene.errors });
    if (mode === 'symbol') {
      mockLookupGene.mockRejectedValueOnce(new Error(message));
    } else {
      mockLookupSymbolsBatch.mockResolvedValueOnce(new Map());
      mockResolveSymbolAliases.mockRejectedValueOnce(new Error(message));
    }
    const input = ensemblLookupGene.input.parse(
      mode === 'symbol' ? { symbol: 'X' } : { symbols: ['X'] },
    );
    const start = process.threadCpuUsage();
    // Matches no pattern, so it passes through unclassified.
    await expect(ensemblLookupGene.handler(input, ctx)).rejects.toThrow(message.slice(0, 40));
    const used = process.threadCpuUsage(start);
    return used.user + used.system;
  }

  it.each(['symbol', 'symbols'] as const)(
    'stays linear in the echoed message length (%s path)',
    async (mode) => {
      await classifyCpu(mode, nearMiss(5_000)); // warm up
      const small = await classifyCpu(mode, nearMiss(5_000));
      const large = await classifyCpu(mode, nearMiss(320_000));
      // 64x the input: a linear scan stays far under 256x; a quadratic one would not.
      expect(large / Math.max(small, 1)).toBeLessThan(256);
      expect(large).toBeLessThan(200_000);
    },
  );
});
