/**
 * @fileoverview Tests for the ensembl_get_sequence tool.
 * @module tests/tools/get-sequence.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGetSequence } from '@/mcp-server/tools/definitions/get-sequence.tool.js';
import type { SequenceRecord } from '@/services/ensembl/types.js';

const mockGetSequenceById = vi.fn();
const mockGetSequenceByRegion = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    getSequenceById: mockGetSequenceById,
    getSequenceByRegion: mockGetSequenceByRegion,
  }),
}));

const mockSequence: SequenceRecord = {
  id: 'ENSG00000139618',
  type: 'genomic',
  seq: 'ATCGATCGATCG',
  length: 12,
  description: 'BRCA2 gene genomic sequence',
};

const mockProteinSeq: SequenceRecord = {
  id: 'ENST00000380152',
  type: 'protein',
  seq: 'MPIGSKERPTFFEIFKTRCNKADLTHGGFKV',
  length: 31,
};

describe('ensemblGetSequence', () => {
  it('fetches genomic sequence by stable ID', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockSequence);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG00000139618', type: 'genomic' });
    const result = await ensemblGetSequence.handler(input, ctx);
    expect(result.id).toBe('ENSG00000139618');
    expect(result.type).toBe('genomic');
    expect(result.seq).toBe('ATCGATCGATCG');
    expect(result.length).toBe(12);
  });

  it('defaults type to genomic when not specified', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockSequence);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG00000139618' });
    expect(input.type).toBe('genomic');
    const result = await ensemblGetSequence.handler(input, ctx);
    expect(result.type).toBe('genomic');
  });

  it('fetches protein sequence by transcript ID', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockProteinSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({
      id: 'ENST00000380152',
      type: 'protein',
    });
    const result = await ensemblGetSequence.handler(input, ctx);
    expect(result.type).toBe('protein');
    expect(result.seq).toContain('M');
  });

  it('reports protein length in residues, not base pairs', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockProteinSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENST00000380152', type: 'protein' });
    const result = await ensemblGetSequence.handler(input, ctx);
    expect(result.length).toBe(31);
    const text = (ensemblGetSequence.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('31 residues');
    expect(text).not.toContain('bp/aa');
  });

  it('detects region mode and calls getSequenceByRegion', async () => {
    const regionSeq = { ...mockSequence, id: 'homo_sapiens:13:32315086-32400268' };
    mockGetSequenceByRegion.mockResolvedValueOnce(regionSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({
      id: 'homo_sapiens:13:32315086-32400268',
      species: 'homo_sapiens',
    });
    const result = await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceByRegion).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('detects region mode for dotted scaffold/patch names', async () => {
    const regionSeq = { ...mockSequence, id: 'homo_sapiens:GL000220.1:1-1000' };
    mockGetSequenceByRegion.mockResolvedValueOnce(regionSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({
      id: 'homo_sapiens:GL000220.1:1-1000',
      species: 'homo_sapiens',
    });
    const result = await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceByRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      'GL000220.1:1-1000',
      0,
      0,
      ctx,
    );
    expect(result).toBeDefined();
  });

  it('throws type_mismatch when requesting protein from a gene ID', async () => {
    mockGetSequenceById.mockRejectedValueOnce(new Error('protein type incompatible with gene ID'));
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG00000139618', type: 'protein' });
    await expect(ensemblGetSequence.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'type_mismatch' },
    });
  });

  it('throws type_mismatch for the Ensembl multiple sequences error message', async () => {
    // Ensembl returns this specific message when requesting non-genomic type for a gene ID
    mockGetSequenceById.mockRejectedValueOnce(
      new Error(
        'Requesting a gene and type not equal to "genomic" can result in multiple sequences. 15 sequences detected.',
      ),
    );
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG00000139618', type: 'protein' });
    await expect(ensemblGetSequence.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'type_mismatch' },
    });
  });

  it('throws not_found when stable ID does not exist', async () => {
    mockGetSequenceById.mockRejectedValueOnce(new Error('ID ENSG99999999999 not found in Ensembl'));
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG99999999999' });
    await expect(ensemblGetSequence.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('formats short sequence inline without truncation', () => {
    const output = { id: 'ENST00000380152', type: 'protein', seq: 'MPIGSKER', length: 8 };
    const blocks = ensemblGetSequence.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENST00000380152');
    expect(text).toContain('protein');
    expect(text).toContain('MPIGSKER');
    expect(text).not.toContain('total characters');
  });

  it('formats long sequence with truncation notice', () => {
    const longSeq = 'A'.repeat(300);
    const output = { id: 'ENSG00000139618', type: 'genomic', seq: longSeq, length: 300 };
    const blocks = ensemblGetSequence.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('total characters');
    expect(text).toContain('300 bp');
    // Only first 200 chars shown
    expect(text).toContain('A'.repeat(200));
  });

  it('formats sequence with optional description when present', () => {
    const output = {
      id: 'ENSG00000139618',
      type: 'genomic',
      seq: 'ATCG',
      length: 4,
      description: 'BRCA2 genomic',
    };
    const blocks = ensemblGetSequence.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('BRCA2 genomic');
  });
});
