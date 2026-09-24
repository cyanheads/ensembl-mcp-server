/**
 * @fileoverview Tests for the ensembl_query_region tool.
 * @module tests/tools/query-region.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblQueryRegion } from '@/mcp-server/tools/definitions/query-region.tool.js';
import type { OverlapFeature } from '@/services/ensembl/types.js';

const mockQueryRegion = vi.fn();
const mockGetDefaultAssemblyName = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    queryRegion: mockQueryRegion,
    getDefaultAssemblyName: mockGetDefaultAssemblyName,
  }),
}));

beforeEach(() => {
  mockQueryRegion.mockReset();
  mockGetDefaultAssemblyName.mockReset();
  mockGetDefaultAssemblyName.mockResolvedValue('GRCh38');
});

/** Concatenated text of every `content[]` block — what a `content`-only client reads. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

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

  it('surfaces the declared recovery hint on an invalid_region error (issue #16)', async () => {
    mockQueryRegion.mockRejectedValueOnce(new Error('invalid region coordinate parse error'));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: 'bad:region:format',
    });
    await expect(ensemblQueryRegion.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'invalid_region',
        recovery: {
          hint: ensemblQueryRegion.errors!.find((e) => e.reason === 'invalid_region')!.recovery,
        },
      },
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

  it('empty result notice includes intergenic guidance and lookup hint', async () => {
    mockQueryRegion.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:1000-2000',
    });
    await ensemblQueryRegion.handler(input, ctx);
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toContain('intergenic');
    expect(notice).toContain('ensembl_lookup_gene');
    // Issue #10: chr-prefixed names are accepted, so an empty result must not blame the chr prefix.
    expect(notice).not.toContain('"chr" prefix');
  });

  it('warns about a large result set above 1000 features', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      ...brca2Feature,
      id: `rs${i}`,
      featureType: 'variation',
    }));
    mockQueryRegion.mockResolvedValueOnce(many);
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:32315086-32400268',
      feature: ['variation'],
    });
    const result = await ensemblQueryRegion.handler(input, ctx);
    expect(result.totalCount).toBe(1500);
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toContain('Large result set (1500 features)');
    expect(notice).toContain('narrowing the region or filtering by biotype');
  });

  it('returns an at-or-under-threshold result unchanged on both surfaces', async () => {
    mockQueryRegion.mockResolvedValueOnce([brca2Feature]);
    const result = await runToolContract(ensemblQueryRegion, {
      species: 'homo_sapiens',
      region: '13:32315086-32400268',
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      totalCount: 1,
      region: '13:32315086-32400268',
      species: 'homo_sapiens',
      features: [{ id: 'ENSG00000139618', name: 'BRCA2', featureType: 'gene' }],
    });
    expect(structured.notice).toBeUndefined();
    expect(structured.truncated).toBeUndefined();
    const text = contentText(result);
    expect(text).toContain('BRCA2');
    expect(text).toContain('13:32315086-32400268');
  });

  describe('empty feature list (issue #21)', () => {
    it('rejects feature: [] at the schema boundary, naming the supported types, before any request', async () => {
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: '11:5227002-5227020',
        feature: [],
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      const hint = (result.structuredContent as { error: { data: { recovery: { hint: string } } } })
        .error.data.recovery.hint;
      for (const type of ['gene', 'transcript', 'variation', 'regulatory', 'exon']) {
        expect(hint).toContain(type);
      }
      expect(mockQueryRegion).not.toHaveBeenCalled();
    });

    it('advertises minItems 1 on the feature array', () => {
      const schema = z.toJSONSchema(ensemblQueryRegion.input, { io: 'input' }) as {
        properties: Record<string, { minItems?: number }>;
      };
      expect(schema.properties.feature?.minItems).toBe(1);
    });
  });

  describe('blank required identifiers (issue #22)', () => {
    it.each([
      ['species', { species: '', region: '1:1-1000' }],
      ['species', { species: '   ', region: '1:1-1000' }],
      ['region', { species: 'homo_sapiens', region: '' }],
      ['region', { species: 'homo_sapiens', region: ' \t ' }],
    ])('rejects a blank %s as invalid_arguments before any request', async (field, args) => {
      const result = await runToolContract(ensemblQueryRegion, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(contentText(result)).toContain(field);
      expect(mockQueryRegion).not.toHaveBeenCalled();
    });
  });

  describe('oversized region (issue #24)', () => {
    const lengthMessage =
      '5000001 is greater than the maximum allowed length of 5000000. Request smaller regions of sequence';

    it('classifies the upstream maximum-length message as invalid_region with the size limit in recovery', async () => {
      // fetchJson surfaces an unrecognized Ensembl error envelope as NotFound.
      mockQueryRegion.mockRejectedValueOnce(notFound(lengthMessage));
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: '1:1-5000001',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region' } },
      });
      const text = contentText(result);
      expect(text).toContain('5,000,000');
      expect(text).toContain('(reason invalid_region)');
    });

    it('forwards an at-limit region unchanged — no local clipping or rewriting', async () => {
      mockQueryRegion.mockResolvedValueOnce([brca2Feature]);
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: '1:1-5000000',
        biotype: 'protein_coding',
      });
      expect(result.isError).toBeUndefined();
      expect(mockQueryRegion).toHaveBeenCalledWith(
        'homo_sapiens',
        '1:1-5000000',
        ['gene'],
        'protein_coding',
        expect.anything(),
      );
    });
  });

  describe('out-of-bounds, reversed, and undecodable regions (issue #27)', () => {
    const recovery = () =>
      ensemblQueryRegion.errors!.find((e) => e.reason === 'invalid_region')!.recovery;

    it.each([
      [
        '1:250000000-250000100',
        'Cannot request a slice whose start (250000000) is greater than 248956422 for 1.',
      ],
      [
        '1:500-100',
        'Cannot request a slice whose start is greater than its end. Start: 500. End: 100',
      ],
      ['1:1-5000000.5', 'Could not decode region 1:1-5000000.5'],
    ])('classifies %s as invalid_region with the declared recovery', async (region, message) => {
      // fetchJson surfaces an unrecognized Ensembl error envelope as NotFound.
      mockQueryRegion.mockRejectedValueOnce(notFound(message));
      const result = await runToolContract(ensemblQueryRegion, { species: 'homo_sapiens', region });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region', recovery: { hint: recovery() } } },
      });
      const text = contentText(result);
      expect(text).toContain(message);
      expect(text).toContain('(reason invalid_region)');
    });

    it('still matches "invalid" followed by "region" on one line', async () => {
      mockQueryRegion.mockRejectedValueOnce(notFound('Invalid requested region 13:abc'));
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: '13:abc',
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region' } },
      });
    });

    it('classifies a pathological echoed region in linear time', async () => {
      // "invalid" repeated with no "region" after it is the backtracking worst case for
      // /invalid.*region/: ~210k characters took seconds; a linear scan takes about a millisecond.
      const echoed = 'invalid'.repeat(30_000);
      mockQueryRegion.mockRejectedValueOnce(notFound(`No slice found for location ${echoed}`));
      const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
      const input = ensemblQueryRegion.input.parse({ species: 'homo_sapiens', region: echoed });
      const started = performance.now();
      await expect(ensemblQueryRegion.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_region' },
      });
      expect(performance.now() - started).toBeLessThan(250);
    });
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

  it('renders parent transcript context for repeated exon rows (issue #9)', () => {
    // The same exon ID is reported once per parent transcript it belongs to — the rows differ
    // only by parentId, so surfacing that discriminator explains why the ID repeats.
    const sharedExonId = 'ENSE00001484009';
    const exonRows: OverlapFeature[] = [
      {
        id: sharedExonId,
        featureType: 'exon',
        chromosome: '13',
        start: 32316422,
        end: 32316527,
        strand: 1,
        parentId: 'ENST00000380152',
        rank: 2,
      },
      {
        id: sharedExonId,
        featureType: 'exon',
        chromosome: '13',
        start: 32316422,
        end: 32316527,
        strand: 1,
        parentId: 'ENST00000544455',
        rank: 2,
      },
    ];
    const output = {
      features: exonRows,
      totalCount: exonRows.length,
      region: '13:32315086-32317000',
      species: 'homo_sapiens',
    };
    const blocks = ensemblQueryRegion.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Parent transcript');
    expect(text).toContain('ENST00000380152');
    expect(text).toContain('ENST00000544455');
    expect(text).toContain('exon rank 2');
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

/** N variation rows on GRCh38 — the per-feature assembly source. */
function variations(n: number, assemblyName = 'GRCh38'): OverlapFeature[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `rs${i + 1}`,
    featureType: 'variation',
    chromosome: '13',
    start: 32315086 + i,
    end: 32315086 + i,
    strand: 1,
    assemblyName,
  }));
}

const brca2Variation = { species: 'homo_sapiens', region: '13:32315086-32400268' } as const;

describe('ensemblQueryRegion max_results cap (issue #17)', () => {
  it('caps to 100 by default while totalCount stays the true pre-cap count on both surfaces', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(250));
    const result = await runToolContract(ensemblQueryRegion, {
      ...brca2Variation,
      feature: ['variation'],
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      features: OverlapFeature[];
      totalCount: number;
      truncated?: boolean;
      shown?: number;
      cap?: number;
      notice?: string;
    };
    expect(structured.features).toHaveLength(100);
    expect(structured.features[0]?.id).toBe('rs1');
    expect(structured.features[99]?.id).toBe('rs100');
    expect(structured.totalCount).toBe(250);
    expect(structured).toMatchObject({ truncated: true, shown: 100, cap: 100 });
    expect(structured.notice).toContain('Showing 100 of 250 features');
    expect(structured.notice).toContain('max_results');

    const text = contentText(result);
    expect(text).toContain('**Features found:** 100 of 250');
    expect(text).toContain('rs100');
    expect(text).not.toContain('rs101');
    expect(text).toContain('> Showing 100 of 250 features');
  });

  it('returns a result exactly at the cap unchanged — no truncation, no notice', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(100));
    const result = await runToolContract(ensemblQueryRegion, {
      ...brca2Variation,
      feature: ['variation'],
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured.features as unknown[]).length).toBe(100);
    expect(structured.totalCount).toBe(100);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toBeUndefined();
    expect(contentText(result)).toContain('**Features found:** 100\n');
  });

  it('returns every feature when max_results is 0', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(250));
    const result = await runToolContract(ensemblQueryRegion, {
      ...brca2Variation,
      feature: ['variation'],
      max_results: 0,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured.features as unknown[]).length).toBe(250);
    expect(structured.totalCount).toBe(250);
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toBeUndefined();
  });

  it('returns everything when max_results exceeds the result size', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(7));
    const result = await runToolContract(ensemblQueryRegion, {
      ...brca2Variation,
      feature: ['variation'],
      max_results: 500,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured.features as unknown[]).length).toBe(7);
    expect(structured.truncated).toBeUndefined();
  });

  it('composes truncation and the >1000 warning into ONE notice', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(1500));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({ ...brca2Variation, feature: ['variation'] });
    const result = await ensemblQueryRegion.handler(input, ctx);
    expect(result.features).toHaveLength(100);
    expect(result.totalCount).toBe(1500);
    const enrichment = getEnrichment(ctx) as {
      notice?: string;
      truncated?: boolean;
      shown?: number;
      cap?: number;
    };
    expect(enrichment).toMatchObject({ truncated: true, shown: 100, cap: 100 });
    expect(enrichment.notice).toContain('Showing 100 of 1500 features');
    expect(enrichment.notice).toContain('Large result set (1500 features)');
  });

  it('keeps the >1000 warning without truncation when uncapped', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(1500));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      ...brca2Variation,
      feature: ['variation'],
      max_results: 0,
    });
    const result = await ensemblQueryRegion.handler(input, ctx);
    expect(result.features).toHaveLength(1500);
    const enrichment = getEnrichment(ctx) as { notice?: string; truncated?: boolean };
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toContain('Large result set (1500 features)');
    expect(enrichment.notice).not.toContain('Showing');
  });

  it('never forwards max_results upstream — feature and biotype reach the service unchanged', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(3));
    await runToolContract(ensemblQueryRegion, {
      ...brca2Variation,
      feature: ['variation', 'gene'],
      biotype: 'SNV',
      max_results: 2,
    });
    expect(mockQueryRegion).toHaveBeenCalledWith(
      'homo_sapiens',
      '13:32315086-32400268',
      ['variation', 'gene'],
      'SNV',
      expect.anything(),
    );
  });

  it.each([
    [-1, 'too_small'],
    [1.5, 'invalid_type'],
  ])(
    'rejects max_results %s as a value error (%s) before any request',
    async (max_results, issueCode) => {
      const result = await runToolContract(ensemblQueryRegion, { ...brca2Variation, max_results });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32602,
          data: { issues: [{ code: issueCode, path: ['max_results'] }] },
        },
      });
      expect(mockQueryRegion).not.toHaveBeenCalled();
    },
  );
});

describe('ensemblQueryRegion assemblyName (issue #23)', () => {
  const regulatory: OverlapFeature = {
    id: 'ENSR1_C4ND',
    featureType: 'regulatory',
    chromosome: '1',
    start: 999971,
    end: 1001148,
    strand: 0,
    description: 'promoter',
  };

  it('sources assemblyName from a feature row with no extra lookup, on both surfaces', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(3));
    const result = await runToolContract(ensemblQueryRegion, {
      ...brca2Variation,
      feature: ['variation'],
    });
    expect(result.structuredContent).toMatchObject({ assemblyName: 'GRCh38' });
    expect(contentText(result)).toContain('**Assembly:** GRCh38');
    expect(mockGetDefaultAssemblyName).not.toHaveBeenCalled();
    // The per-row value is folded into the one top-level field, not repeated per feature.
    const features = (result.structuredContent as { features: Record<string, unknown>[] }).features;
    expect(features.every((f) => !('assemblyName' in f))).toBe(true);
  });

  it('reads the assembly from the full set even when the capped page holds only regulatory rows', async () => {
    mockQueryRegion.mockResolvedValueOnce([regulatory, ...variations(1)]);
    const result = await runToolContract(ensemblQueryRegion, {
      species: 'homo_sapiens',
      region: '1:999000-1002000',
      feature: ['regulatory', 'variation'],
      max_results: 1,
    });
    expect(result.structuredContent).toMatchObject({ assemblyName: 'GRCh38', totalCount: 2 });
    expect(mockGetDefaultAssemblyName).not.toHaveBeenCalled();
  });

  it.each([
    ['regulatory-only', [regulatory]],
    ['empty', []],
  ])('falls back to the species default assembly for a %s result', async (_label, rows) => {
    mockQueryRegion.mockResolvedValueOnce(rows);
    const result = await runToolContract(ensemblQueryRegion, {
      species: 'homo_sapiens',
      region: '1:999000-1002000',
      feature: ['regulatory'],
    });
    expect(mockGetDefaultAssemblyName).toHaveBeenCalledTimes(1);
    expect(mockGetDefaultAssemblyName).toHaveBeenCalledWith('homo_sapiens', expect.anything());
    expect(result.structuredContent).toMatchObject({ assemblyName: 'GRCh38' });
    expect(contentText(result)).toContain('**Assembly:** GRCh38');
  });

  it('reports GRCh37 from either source when the endpoint serves GRCh37', async () => {
    mockQueryRegion.mockResolvedValueOnce(variations(1, 'GRCh37'));
    const perFeature = await runToolContract(ensemblQueryRegion, brca2Variation);
    expect(perFeature.structuredContent).toMatchObject({ assemblyName: 'GRCh37' });

    mockQueryRegion.mockResolvedValueOnce([regulatory]);
    mockGetDefaultAssemblyName.mockResolvedValueOnce('GRCh37');
    const fallback = await runToolContract(ensemblQueryRegion, brca2Variation);
    expect(fallback.structuredContent).toMatchObject({ assemblyName: 'GRCh37' });
  });

  it('succeeds without assemblyName and discloses the gap when the fallback fails', async () => {
    mockQueryRegion.mockResolvedValueOnce([regulatory]);
    mockGetDefaultAssemblyName.mockRejectedValueOnce(new Error('Ensembl API returned HTTP 503.'));
    const result = await runToolContract(ensemblQueryRegion, {
      species: 'homo_sapiens',
      region: '1:999000-1002000',
      feature: ['regulatory'],
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.assemblyName).toBeUndefined();
    expect(structured.totalCount).toBe(1);
    expect(structured.notice).toContain('could not be resolved');
    const text = contentText(result);
    expect(text).not.toContain('**Assembly:**');
    expect(text).toContain('could not be resolved');
  });

  it('composes the empty-result notice with the assembly gap into one notice', async () => {
    mockQueryRegion.mockResolvedValueOnce([]);
    mockGetDefaultAssemblyName.mockRejectedValueOnce(new Error('Ensembl API returned HTTP 503.'));
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '13:1000-2000',
    });
    await ensemblQueryRegion.handler(input, ctx);
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toContain('intergenic');
    expect(notice).toContain('could not be resolved');
  });

  it('propagates a caller cancellation instead of degrading to a notice', async () => {
    const controller = new AbortController();
    mockQueryRegion.mockResolvedValueOnce([regulatory]);
    mockGetDefaultAssemblyName.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const ctx = createMockContext({ errors: ensemblQueryRegion.errors, signal: controller.signal });
    const input = ensemblQueryRegion.input.parse({
      species: 'homo_sapiens',
      region: '1:999000-1002000',
      feature: ['regulatory'],
    });
    await expect(ensemblQueryRegion.handler(input, ctx)).rejects.toThrow('aborted');
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });
});
