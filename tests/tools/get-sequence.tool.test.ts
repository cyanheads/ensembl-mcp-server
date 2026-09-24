/**
 * @fileoverview Tests for the ensembl_get_sequence tool.
 * @module tests/tools/get-sequence.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Deterministic non-repeating ACGT text, so a mis-sliced window never matches by accident. */
function dna(length: number, seed = 7): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += 'ACGT'[(x >>> 16) & 3];
  }
  return out;
}

/** Concatenated text of every `content[]` block — what a `content`-only client reads. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

type WindowResult = {
  seq: string;
  length: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number;
  notice?: string;
};

const mockProteinSeq: SequenceRecord = {
  id: 'ENST00000380152',
  type: 'protein',
  seq: 'MPIGSKERPTFFEIFKTRCNKADLTHGGFKV',
  length: 31,
};

describe('ensemblGetSequence', () => {
  beforeEach(() => {
    mockGetSequenceById.mockReset();
    mockGetSequenceByRegion.mockReset();
  });

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

  it('forwards expand params to getSequenceById for genomic stable-ID lookups (issue #13)', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockSequence);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({
      id: 'ENSG00000139618',
      type: 'genomic',
      expand_5prime: 10,
      expand_3prime: 10,
    });
    await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceById).toHaveBeenCalledWith('ENSG00000139618', 'genomic', 10, 10, ctx);
    expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
  });

  it('routes a bare chr:start-end region to getSequenceByRegion when species is set (issue #14)', async () => {
    const regionSeq = { ...mockSequence, id: '13:32315086-32315100' };
    mockGetSequenceByRegion.mockResolvedValueOnce(regionSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({
      id: '13:32315086-32315100',
      species: 'homo_sapiens',
      type: 'genomic',
    });
    await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceByRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32315100',
      0,
      0,
      ctx,
    );
    expect(mockGetSequenceById).not.toHaveBeenCalled();
  });

  it('routes the embedded species:chr:start-end form to getSequenceByRegion (issue #14)', async () => {
    const regionSeq = { ...mockSequence, id: 'homo_sapiens:13:32315086-32315100' };
    mockGetSequenceByRegion.mockResolvedValueOnce(regionSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    // Species field omitted — the embedded prefix must supply the species.
    const input = ensemblGetSequence.input.parse({ id: 'homo_sapiens:13:32315086-32315100' });
    await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceByRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32315100',
      0,
      0,
      ctx,
    );
  });

  it('honors expand params on a bare region (issue #14)', async () => {
    const regionSeq = { ...mockSequence, id: '13:32315086-32315100' };
    mockGetSequenceByRegion.mockResolvedValueOnce(regionSeq);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({
      id: '13:32315086-32315100',
      species: 'homo_sapiens',
      expand_5prime: 25,
      expand_3prime: 30,
    });
    await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceByRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32315100',
      25,
      30,
      ctx,
    );
  });

  it('routes a stable ID to getSequenceById, not region (issue #14)', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockSequence);
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG00000139618' });
    await ensemblGetSequence.handler(input, ctx);
    expect(mockGetSequenceById).toHaveBeenCalled();
    expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
  });

  it('throws missing_species for a bare region without a species (issue #14)', async () => {
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: '13:32315086-32315100' });
    await expect(ensemblGetSequence.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_species' },
    });
    expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
    expect(mockGetSequenceById).not.toHaveBeenCalled();
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

  it('surfaces the declared recovery hint on a type_mismatch error (issue #16)', async () => {
    mockGetSequenceById.mockRejectedValueOnce(new Error('protein type incompatible with gene ID'));
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: 'ENSG00000139618', type: 'protein' });
    await expect(ensemblGetSequence.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'type_mismatch',
        recovery: {
          hint: ensemblGetSequence.errors!.find((e) => e.reason === 'type_mismatch')!.recovery,
        },
      },
    });
  });

  it('formats short sequence inline without truncation', () => {
    const output = {
      id: 'ENST00000380152',
      type: 'protein',
      seq: 'MPIGSKER',
      length: 8,
      offset: 0,
      truncated: false,
    };
    const blocks = ensemblGetSequence.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('ENST00000380152');
    expect(text).toContain('protein');
    expect(text).toContain('MPIGSKER');
    expect(text).toContain('not truncated');
    expect(text).not.toContain('next offset');
  });

  it('formats a window longer than 200 characters in full, with the window range', () => {
    const window = dna(300);
    const output = {
      id: 'ENSG00000139618',
      type: 'genomic',
      seq: window,
      length: 85183,
      offset: 0,
      truncated: true,
      nextOffset: 300,
    };
    const text = (ensemblGetSequence.format!(output)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(window);
    expect(text).toContain('85,183 bp');
    expect(text).toContain('300 characters from offset 0');
    expect(text).toContain('next offset 300');
  });

  it('formats sequence with optional description when present', () => {
    const output = {
      id: 'ENSG00000139618',
      type: 'genomic',
      seq: 'ATCG',
      length: 4,
      offset: 0,
      truncated: false,
      description: 'BRCA2 genomic',
    };
    const blocks = ensemblGetSequence.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('BRCA2 genomic');
  });
});

describe('ensemblGetSequence sequence windows (issue #19)', () => {
  const brca2 = dna(85_183);
  const brca2Record: SequenceRecord = {
    id: 'ENSG00000139618',
    type: 'genomic',
    seq: brca2,
    length: brca2.length,
  };

  beforeEach(() => {
    mockGetSequenceById.mockReset();
    mockGetSequenceByRegion.mockReset();
    mockGetSequenceById.mockResolvedValue(brca2Record);
  });

  it('returns the first 10,000 characters by default with the full length on both surfaces', async () => {
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000139618' });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as WindowResult;
    expect(structured.seq).toBe(brca2.slice(0, 10_000));
    expect(structured).toMatchObject({
      length: 85_183,
      offset: 0,
      truncated: true,
      nextOffset: 10_000,
    });
    expect(structured.notice).toContain('10,000 of 85,183');
    expect(structured.notice).toContain('offset 10000');

    const text = contentText(result);
    // The whole window reaches content[], not a preview of it.
    expect(text).toContain(brca2.slice(0, 10_000));
    expect(text).not.toContain(brca2.slice(0, 10_001));
    expect(text).toContain('next offset 10000');
    expect(text).toContain('> Showing 10,000 of 85,183');
  });

  it('walking nextOffset reconstructs the full sequence byte-for-byte', async () => {
    const pages: WindowResult[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await runToolContract(ensemblGetSequence, {
        id: 'ENSG00000139618',
        offset,
        max_length: 30_000,
      });
      const page = result.structuredContent as WindowResult;
      // content[] carries the same window as structuredContent on every page.
      expect(contentText(result)).toContain(page.seq);
      pages.push(page);
      offset = page.nextOffset;
    }
    expect(pages.map((p) => p.offset)).toEqual([0, 30_000, 60_000]);
    expect(pages.map((p) => p.seq).join('')).toBe(brca2);
    const last = pages.at(-1)!;
    expect(last.seq).toHaveLength(25_183);
    expect(last.truncated).toBe(false);
    expect(last).not.toHaveProperty('nextOffset');
    expect(last.notice).toBeUndefined();
    expect(pages.every((p) => p.length === 85_183)).toBe(true);
  });

  it('walks the default window to the end in nine pages', async () => {
    let joined = '';
    let offset: number | undefined = 0;
    let calls = 0;
    while (offset !== undefined) {
      const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000139618', offset });
      const page = result.structuredContent as WindowResult;
      joined += page.seq;
      offset = page.nextOffset;
      calls++;
    }
    expect(calls).toBe(9);
    expect(joined).toBe(brca2);
  });

  it('max_length 0 returns everything from offset to the end, uncapped', async () => {
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENSG00000139618',
      offset: 5_000,
      max_length: 0,
    });
    const structured = result.structuredContent as WindowResult;
    expect(structured.seq).toBe(brca2.slice(5_000));
    expect(structured).toMatchObject({ length: 85_183, offset: 5_000, truncated: false });
    expect(structured).not.toHaveProperty('nextOffset');
    expect(structured.notice).toBeUndefined();
    expect(contentText(result)).toContain(brca2.slice(5_000));
  });

  it('returns a sequence exactly at the window size whole, with no truncation or notice', async () => {
    const exact = dna(10_000, 11);
    mockGetSequenceById.mockResolvedValueOnce({ ...brca2Record, seq: exact, length: 10_000 });
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000139618' });
    const structured = result.structuredContent as WindowResult;
    expect(structured.seq).toBe(exact);
    expect(structured).toMatchObject({ length: 10_000, offset: 0, truncated: false });
    expect(structured).not.toHaveProperty('nextOffset');
    expect(structured.notice).toBeUndefined();
  });

  it.each([
    ['past the end', 90_000],
    ['exactly at the end', 85_183],
  ])('returns an empty window with a notice for an offset %s, not an error', async (_l, offset) => {
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000139618', offset });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as WindowResult;
    expect(structured).toMatchObject({ seq: '', length: 85_183, offset, truncated: false });
    expect(structured).not.toHaveProperty('nextOffset');
    expect(structured.notice).toContain(`offset ${offset}`);
    expect(structured.notice).toContain('85,183');
    const text = contentText(result);
    expect(text).toContain('No sequence characters at this offset');
    expect(text).toContain(`> No characters returned: offset ${offset}`);
  });

  it('slices the sequence the service resolved, after expansion, in region mode', async () => {
    const expanded = dna(35, 3);
    mockGetSequenceByRegion.mockResolvedValueOnce({
      id: 'chromosome:GRCh38:13:32315076:32315110:1',
      type: 'genomic',
      seq: expanded,
      length: 35,
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: '13:32315086-32315100',
      species: 'homo_sapiens',
      expand_5prime: 10,
      expand_3prime: 10,
      offset: 5,
      max_length: 20,
    });
    expect(mockGetSequenceByRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32315100',
      10,
      10,
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      seq: expanded.slice(5, 25),
      length: 35,
      offset: 5,
      truncated: true,
      nextOffset: 25,
    });
  });

  it.each([
    [{ offset: -1 }, 'offset'],
    [{ offset: 1.5 }, 'offset'],
    [{ max_length: -5 }, 'max_length'],
  ])('rejects %j as invalid_arguments before any request', async (args, field) => {
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000139618', ...args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments', issues: [{ path: [field] }] } },
    });
    expect(mockGetSequenceById).not.toHaveBeenCalled();
  });
});

describe('ensemblGetSequence non-genomic type in region mode (issue #25)', () => {
  beforeEach(() => {
    mockGetSequenceById.mockReset();
    mockGetSequenceByRegion.mockReset();
  });

  const typeMismatchRecovery = () =>
    ensemblGetSequence.errors!.find((e) => e.reason === 'type_mismatch')!.recovery;

  it.each([
    ['prefixed', { id: 'homo_sapiens:13:32315086-32320268' }, 'cdna'],
    ['prefixed', { id: 'homo_sapiens:13:32315086-32320268' }, 'cds'],
    ['prefixed', { id: 'homo_sapiens:13:32315086-32320268' }, 'protein'],
    ['bare', { id: '13:32315086-32320268', species: 'homo_sapiens' }, 'cdna'],
    ['bare', { id: '13:32315086-32320268', species: 'homo_sapiens' }, 'cds'],
    ['bare', { id: '13:32315086-32320268', species: 'homo_sapiens' }, 'protein'],
  ])(
    'rejects a %s region with type %s as type_mismatch before any request',
    async (_form, args, type) => {
      const result = await runToolContract(ensemblGetSequence, { ...args, type } as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'type_mismatch', recovery: { hint: typeMismatchRecovery() } },
        },
      });
      const text = contentText(result);
      expect(text).toContain(`"${type}"`);
      expect(text).toContain('genomic-only');
      expect(text).toContain('(reason type_mismatch)');
      expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
      expect(mockGetSequenceById).not.toHaveBeenCalled();
    },
  );

  it('covers region ids in the declared type_mismatch contract', () => {
    const entry = ensemblGetSequence.errors!.find((e) => e.reason === 'type_mismatch')!;
    expect(entry.when).toContain('region');
    expect(entry.recovery).toContain('genomic-only');
  });

  it('states in the type field description that region ids are genomic-only', () => {
    expect(ensemblGetSequence.input.shape.type.description).toContain('genomic-only');
  });

  it.each([
    ['omitted', {}],
    ['genomic', { type: 'genomic' as const }],
  ])('proceeds in region mode when type is %s', async (_label, typeArg) => {
    mockGetSequenceByRegion.mockResolvedValueOnce({ ...mockSequence, id: '13:1-12' });
    const result = await runToolContract(ensemblGetSequence, {
      id: '13:32315086-32315100',
      species: 'homo_sapiens',
      ...typeArg,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ type: 'genomic' });
    expect(mockGetSequenceByRegion).toHaveBeenCalledTimes(1);
  });

  it('leaves stable-ID mode unaffected: a non-genomic type on a transcript ID reaches the service', async () => {
    mockGetSequenceById.mockResolvedValueOnce(mockProteinSeq);
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENST00000380152',
      type: 'cdna',
    });
    expect(result.isError).toBeUndefined();
    expect(mockGetSequenceById).toHaveBeenCalledWith(
      'ENST00000380152',
      'cdna',
      0,
      0,
      expect.anything(),
    );
    expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
  });
});

describe('ensemblGetSequence invalid_region contract (issue #28)', () => {
  it('declares invalid_region as a ValidationError naming the 10,000,000-base limit', () => {
    const entry = ensemblGetSequence.errors!.find((e) => e.reason === 'invalid_region')!;
    expect(entry.code).toBe(-32007);
    expect(entry.when).toContain('start after its end');
    expect(entry.when).toContain('10,000,000');
    expect(entry.recovery).toContain('10,000,000');
  });

  it('states the region bounds in the id description', () => {
    const text = ensemblGetSequence.input.shape.id.description!;
    expect(text).toContain('start at or below end');
    expect(text).toContain('10,000,000 bases');
  });

  it('rejects reversed coordinates without calling the service', async () => {
    mockGetSequenceByRegion.mockClear();
    const ctx = createMockContext({ errors: ensemblGetSequence.errors });
    const input = ensemblGetSequence.input.parse({ id: '1:500-100', species: 'homo_sapiens' });
    await expect(ensemblGetSequence.handler(input, ctx)).rejects.toMatchObject({
      code: -32007,
      data: { reason: 'invalid_region' },
    });
    expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
  });
});

describe('ensemblGetSequence blank id (issue #22)', () => {
  it.each(['', '   '])('rejects id %j as invalid_arguments before any request', async (id) => {
    mockGetSequenceById.mockClear();
    mockGetSequenceByRegion.mockClear();
    const result = await runToolContract(ensemblGetSequence, { id, type: 'genomic' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(mockGetSequenceById).not.toHaveBeenCalled();
    expect(mockGetSequenceByRegion).not.toHaveBeenCalled();
  });

  it('forwards a padded stable ID trimmed', async () => {
    mockGetSequenceById.mockReset();
    mockGetSequenceById.mockResolvedValueOnce(mockSequence);
    const result = await runToolContract(ensemblGetSequence, { id: '  ENSG00000139618 ' });
    expect(result.isError).toBeUndefined();
    expect(mockGetSequenceById).toHaveBeenCalledWith(
      'ENSG00000139618',
      'genomic',
      0,
      0,
      expect.anything(),
    );
  });

  it('routes a padded region to region mode', async () => {
    mockGetSequenceByRegion.mockReset();
    mockGetSequenceByRegion.mockResolvedValueOnce({ ...mockSequence, id: '13:1-12' });
    await runToolContract(ensemblGetSequence, {
      id: ' 13:32315086-32315100 ',
      species: 'homo_sapiens',
    });
    expect(mockGetSequenceByRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32315100',
      0,
      0,
      expect.anything(),
    );
  });
});
