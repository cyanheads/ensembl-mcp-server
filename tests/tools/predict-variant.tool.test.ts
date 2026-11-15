/**
 * @fileoverview Tests for the ensembl_predict_variant tool.
 * @module tests/tools/predict-variant.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { VepRecord } from '@/services/ensembl/types.js';
import { readMarkdownText } from '../helpers/read-markdown.js';

const mockPredictVariantHgvs = vi.fn();
const mockPredictVariantRegion = vi.fn();
const mockPredictVariantId = vi.fn();

/** When `real` is set, the tool runs against the real EnsemblService over a fetch fake. */
const upstream = vi.hoisted(() => ({ real: false }));

vi.mock('@/services/ensembl/ensembl-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ensembl/ensembl-service.js')>();
  return {
    ...actual,
    getEnsemblService: () =>
      upstream.real
        ? actual.getEnsemblService()
        : {
            predictVariantHgvs: mockPredictVariantHgvs,
            predictVariantRegion: mockPredictVariantRegion,
            predictVariantId: mockPredictVariantId,
          },
  };
});

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
    const result = await runToolContract(ensemblPredictVariant, { variant: 'rs99999999999' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'not_found',
          recovery: {
            hint: ensemblPredictVariant.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
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

describe('ensemblPredictVariant through EnsemblService (issues #34, #37)', () => {
  const VEP = /^https:\/\/rest\.ensembl\.org\/vep\//;
  let http: FetchMockHarness;

  beforeEach(() => {
    upstream.real = true;
    // Strict: an unrouted request throws, so an unexpected upstream call fails the test.
    http = createFetchMock();
    http.install();
    initEnsemblService({} as AppConfig, createInMemoryStorage());
  });

  afterEach(() => {
    http.restore();
    upstream.real = false;
  });

  const recovery = (reason: string) =>
    ensemblPredictVariant.errors!.find((e) => e.reason === reason)!.recovery;

  /** Concatenated text of every `content[]` block — what a `content`-only client reads. */
  const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

  const rejectWith = (error: string) =>
    http.route({ match: VEP, respond: () => Response.json({ error }, { status: 400 }) });

  it.each([
    [
      'an allele that matches the reference',
      '7:140753336:140753336:1/A',
      'request for consequence of [A] matches reference [A]',
      'invalid_notation',
      -32007,
    ],
    [
      'an allele that is not a base or SO term',
      '7:140753336:140753336:1/Z',
      'Allele must be A,T,G,C or SO term [got: Z]',
      'invalid_notation',
      -32007,
    ],
    [
      'a sequence region the assembly lacks',
      '1000:100:100:1/A',
      'No slice found for location 1000',
      'not_found',
      -32001,
    ],
  ])(
    'maps the region+allele rejection of %s to its declared reason',
    async (_label, variant, error, reason, code) => {
      rejectWith(error);
      const result = await runToolContract(ensemblPredictVariant, { variant });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code, data: { reason, recovery: { hint: recovery(reason) } } },
      });
      const text = contentText(result);
      expect(readMarkdownText(text)).toContain(error);
      expect(text).toContain(`Recovery: ${recovery(reason)}`);
      expect(text).toContain(`(reason ${reason})`);
      // A 400 input rejection is answered once, never retried as an outage.
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.request.url).toBe(
        `https://rest.ensembl.org/vep/homo_sapiens/region/${encodeURIComponent(variant.split('/')[0]!)}/${variant.split('/')[1]}?hgvs=1&canonical=1&mane=1`,
      );
    },
  );

  it.each([
    ['region+allele', '7:140753336:140753336:1/T', '/region/'],
    ['HGVS', 'ENST00000380152.8:c.2T>A', '/hgvs/'],
    ['rsID', 'rs334', '/id/'],
  ])('maps an unknown species on the %s path to invalid_species', async (_path, variant, route) => {
    rejectWith("Can not find internal name for species 'not_a_species'");
    const result = await runToolContract(ensemblPredictVariant, {
      variant,
      species: 'not_a_species',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'invalid_species', recovery: { hint: recovery('invalid_species') } },
      },
    });
    expect(recovery('invalid_species')).toContain('ensembl_list_species');
    const text = contentText(result);
    expect(text).toContain('not_a_species');
    expect(text).toContain('(reason invalid_species)');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toContain(`/vep/not_a_species${route}`);
  });

  it('classifies a long echoed rejection in linear time', async () => {
    // Fragments of every pattern the region path and the service test, none completed.
    const unit = 'matches referenc allele must b no slice foun internal name for specie ';
    const cpuMicros = async (size: number) => {
      const error = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      http.route({
        match: VEP,
        once: true,
        respond: () => Response.json({ error }, { status: 400 }),
      });
      const start = process.threadCpuUsage();
      const result = await runToolContract(ensemblPredictVariant, {
        variant: '7:140753336:140753336:1/T',
      });
      const used = process.threadCpuUsage(start);
      // Unrecognized: a ValidationError with no declared reason.
      expect(result.structuredContent).toMatchObject({ error: { code: -32007 } });
      return used.user + used.system;
    };
    await cpuMicros(5_000); // warm-up
    const small = await cpuMicros(5_000);
    const large = await cpuMicros(320_000);
    // 64x the input: linear stays near 64x, quadratic would be ~4096x.
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(250_000);
  });

  /*
   * HBB at GRCh38 11:5227002 (rs334, HbS), trimmed from live VEP records to the fields
   * read. HBB is on the reverse strand, so transcript and protein HGVS records report
   * strand -1 while every colocated variant reports strand 1.
   */
  const HGMD = {
    id: 'CD830010',
    allele_string: 'HGMD_MUTATION',
    strand: 1,
    start: 5227002,
    end: 5227002,
  };
  const RS334 = {
    id: 'rs334',
    allele_string: 'T/A/C/G',
    strand: 1,
    start: 5227002,
    end: 5227002,
    clin_sig: ['not_provided', 'likely_benign', 'pathogenic', 'other', 'protective'],
    clin_sig_ref_allele: 'T',
    clin_sig_allele: 'A:other;A:pathogenic;G:other;A:protective;A:not_provided;G:likely_benign',
  };
  const RS63749819 = {
    id: 'rs63749819',
    allele_string: 'T/-',
    strand: 1,
    start: 5227002,
    end: 5227002,
    clin_sig: ['pathogenic'],
    clin_sig_ref_allele: 'T',
    clin_sig_allele: ':pathogenic',
  };
  const GLU7VAL = {
    consequence_terms: ['missense_variant'],
    impact: 'MODERATE',
    hgvsc: 'ENST00000335295.4:c.20A>T',
    hgvsp: 'ENSP00000333994.3:p.Glu7Val',
    amino_acids: 'E/V',
    sift_prediction: 'deleterious_low_confidence',
    sift_score: 0,
  };
  const GLU7FS = {
    consequence_terms: ['frameshift_variant'],
    impact: 'HIGH',
    hgvsc: 'ENST00000335295.4:c.20del',
    hgvsp: 'ENSP00000333994.3:p.Glu7GlyfsTer13',
  };
  /** The canonical HBB consequence (strand -1) beside an overlapping lncRNA one (strand 1). */
  const hbbConsequences = (allele: string, hbb: Record<string, unknown>) => [
    {
      transcript_id: 'ENST00000335295',
      gene_id: 'ENSG00000244734',
      gene_symbol: 'HBB',
      variant_allele: allele,
      strand: -1,
      canonical: 1,
      mane_select: 'NM_000518.5',
      biotype: 'protein_coding',
      ...hbb,
    },
    {
      transcript_id: 'ENST00000759072',
      gene_id: 'ENSG00000298932',
      variant_allele: allele,
      strand: 1,
      canonical: 1,
      consequence_terms: ['intron_variant', 'non_coding_transcript_variant'],
      impact: 'MODIFIER',
      biotype: 'lncRNA',
    },
  ];
  const hbbRecord = <const T extends Record<string, unknown>>(fields: T) => ({
    seq_region_name: '11',
    start: 5227002,
    end: 5227002,
    assembly_name: 'GRCh38',
    ...fields,
  });

  type Structured = {
    notice?: string;
    results: (VepRecord & { strand?: number })[];
  };

  describe('record and colocated strands (issue #61)', () => {
    it.each([
      {
        label: 'transcript HGVS',
        variant: 'ENST00000335295.4:c.20A>T',
        route: '/hgvs/',
        strand: -1,
        colocated: [HGMD, RS334],
        byAllele: {
          A: ['other', 'pathogenic', 'protective', 'not_provided'],
          G: ['other', 'likely_benign'],
        },
        record: hbbRecord({
          input: 'ENST00000335295.4:c.20A>T',
          allele_string: 'A/T',
          strand: -1,
          most_severe_consequence: 'missense_variant',
          transcript_consequences: hbbConsequences('T', GLU7VAL),
          colocated_variants: [HGMD, RS334],
        }),
      },
      {
        label: 'protein HGVS',
        variant: 'ENSP00000333994.3:p.Glu7Val',
        route: '/hgvs/',
        strand: -1,
        colocated: [HGMD, RS334],
        byAllele: {
          A: ['other', 'pathogenic', 'protective', 'not_provided'],
          G: ['other', 'likely_benign'],
        },
        record: hbbRecord({
          input: 'ENSP00000333994.3:p.Glu7Val',
          allele_string: 'A/T',
          strand: -1,
          most_severe_consequence: 'missense_variant',
          transcript_consequences: hbbConsequences('T', GLU7VAL),
          colocated_variants: [HGMD, RS334],
        }),
      },
      {
        label: 'reverse-strand deletion',
        variant: 'ENST00000335295.4:c.20del',
        route: '/hgvs/',
        strand: -1,
        colocated: [HGMD, RS63749819],
        byAllele: { '-': ['pathogenic'] },
        record: hbbRecord({
          input: 'ENST00000335295.4:c.20del',
          allele_string: 'A/-',
          strand: -1,
          most_severe_consequence: 'frameshift_variant',
          transcript_consequences: hbbConsequences('-', GLU7FS),
          colocated_variants: [HGMD, RS63749819],
        }),
      },
      {
        label: 'region',
        variant: '11:5227002:5227002:1/A',
        route: '/region/',
        strand: 1,
        colocated: [HGMD, RS334],
        byAllele: {
          A: ['other', 'pathogenic', 'protective', 'not_provided'],
          G: ['other', 'likely_benign'],
        },
        record: hbbRecord({
          input: '11 5227002 5227002 T/A 1',
          allele_string: 'T/A',
          strand: 1,
          most_severe_consequence: 'missense_variant',
          transcript_consequences: hbbConsequences('A', GLU7VAL),
          colocated_variants: [HGMD, RS334],
        }),
      },
      {
        label: 'rsID',
        variant: 'rs334',
        route: '/id/',
        strand: 1,
        colocated: [HGMD, RS334],
        byAllele: {
          A: ['other', 'pathogenic', 'protective', 'not_provided'],
          G: ['other', 'likely_benign'],
        },
        record: hbbRecord({
          input: 'rs334',
          allele_string: 'T/A/C/G',
          strand: 1,
          most_severe_consequence: 'missense_variant',
          transcript_consequences: hbbConsequences('A', GLU7VAL),
          colocated_variants: [HGMD, RS334],
        }),
      },
    ])(
      'exposes the reported strands for $label input and passes alleles through',
      async ({ variant, route, strand, colocated, byAllele, record }) => {
        http.route({ match: VEP, respond: () => Response.json([record]) });
        const result = await runToolContract(ensemblPredictVariant, { variant });

        expect(result.isError).toBeUndefined();
        expect(http.calls[0]?.request.url).toContain(route);
        const structured = result.structuredContent as Structured;
        const out = structured.results[0]!;
        expect(out).toMatchObject({ strand, alleleString: record.allele_string });
        expect(out.transcriptConsequences.map((tc) => tc.variantAllele)).toEqual(
          record.transcript_consequences.map((tc) => tc.variant_allele),
        );
        expect(out.colocatedVariants.map((cv) => [cv.id, cv.alleleString, cv.strand])).toEqual(
          colocated.map((cv) => [cv.id, cv.allele_string, 1]),
        );

        // Clinical terms stay on the colocated record that annotates them, keyed as Ensembl keys them.
        const clinical = (o: object) => Object.keys(o).filter((key) => /clinical/i.test(key));
        expect(clinical(out)).toEqual([]);
        for (const tc of out.transcriptConsequences) expect(clinical(tc)).toEqual([]);
        expect(out.colocatedVariants.at(-1)?.clinicalSignificanceByAllele).toEqual(byAllele);

        const text = readMarkdownText(contentText(result));
        expect(text).toContain(`Strand: ${strand}`);
        for (const cv of colocated)
          expect(text).toContain(`${cv.id} (${cv.allele_string}, strand 1)`);

        if (strand === -1) {
          const ids = colocated.map((cv) => cv.id).join(', ');
          expect(structured.notice).toBe(
            `Strands differ: ${record.input} (strand -1) vs colocated ${ids} (strand 1). Reverse-complement one side before matching variantAllele or alleleString against a colocated alleleString or clinicalSignificanceByAllele key.`,
          );
          expect(text).toContain(structured.notice);
        } else {
          expect(structured.notice).toBeUndefined();
        }
      },
    );

    it('raises no strand notice for a reverse-strand record without colocated variants', async () => {
      http.route({
        match: VEP,
        respond: () =>
          Response.json([
            hbbRecord({
              input: 'ENST00000335295.4:c.19_20delinsTT',
              allele_string: 'GA/TT',
              strand: -1,
              end: 5227003,
              most_severe_consequence: 'missense_variant',
              transcript_consequences: hbbConsequences('TT', {
                consequence_terms: ['missense_variant'],
                hgvsc: 'ENST00000335295.4:c.19_20delinsTT',
                hgvsp: 'ENSP00000333994.3:p.Glu7Leu',
              }),
            }),
          ]),
      });
      const result = await runToolContract(ensemblPredictVariant, {
        variant: 'ENST00000335295.4:c.19_20delinsTT',
      });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as Structured;
      expect(structured.results[0]).toMatchObject({ strand: -1, colocatedVariants: [] });
      expect(structured.notice).toBeUndefined();
      expect(readMarkdownText(contentText(result))).toContain('Strand: -1');
    });
  });

  describe('reverse-strand region input (issue #66)', () => {
    /** The GET region URL the service builds for `region` (chr:start:end:strand) and `allele`. */
    const regionUrl = (region: string, allele: string) =>
      `https://rest.ensembl.org/vep/homo_sapiens/region/${encodeURIComponent(region)}/${encodeURIComponent(allele)}?hgvs=1&canonical=1&mane=1`;

    /** Answers each URL in `answers`; any other request is a 400 the tool cannot classify. */
    const respondFrom = (answers: Map<string, unknown>) =>
      http.route({
        match: VEP,
        respond: (request) =>
          answers.has(request.url)
            ? Response.json(answers.get(request.url))
            : Response.json({ error: `unrouted ${request.url}` }, { status: 400 }),
      });

    const resultsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as Structured).results;

    it('answers 11:5227002:5227002:-1/T exactly as 1/A (HBB p.Glu7Val)', async () => {
      respondFrom(
        new Map<string, unknown>([
          [
            regionUrl('11:5227002:5227002:1', 'A'),
            [
              hbbRecord({
                input: '11 5227002 5227002 T/A 1',
                allele_string: 'T/A',
                strand: 1,
                most_severe_consequence: 'missense_variant',
                transcript_consequences: hbbConsequences('A', GLU7VAL),
                colocated_variants: [HGMD, RS334],
              }),
            ],
          ],
          // What GET makes of strand -1: minus-strand reference, forward-scored allele.
          [
            regionUrl('11:5227002:5227002:-1', 'T'),
            [
              hbbRecord({
                input: '11 5227002 5227002 A/T 1',
                allele_string: 'A/T',
                strand: 1,
                most_severe_consequence: 'synonymous_variant',
                transcript_consequences: hbbConsequences('T', {
                  consequence_terms: ['synonymous_variant'],
                  impact: 'LOW',
                  hgvsp: 'ENSP00000333994.3:p.Glu7=',
                  amino_acids: 'E',
                }),
                colocated_variants: [HGMD],
              }),
            ],
          ],
        ]),
      );

      const reverse = await runToolContract(ensemblPredictVariant, {
        variant: '11:5227002:5227002:-1/T',
      });
      const forward = await runToolContract(ensemblPredictVariant, {
        variant: '11:5227002:5227002:1/A',
      });

      expect(reverse.isError).toBeUndefined();
      expect(resultsOf(reverse)).toEqual(resultsOf(forward));
      expect(resultsOf(reverse)).toMatchObject([
        { mostSevereConsequence: 'missense_variant', colocatedVariants: [{}, { id: 'rs334' }] },
      ]);
      expect(http.calls.map((call) => call.request.url)).toEqual([
        regionUrl('11:5227002:5227002:1', 'A'),
        regionUrl('11:5227002:5227002:1', 'A'),
      ]);
      const notice = (reverse.structuredContent as Structured).notice;
      expect(notice).toBe(
        'Converted the reverse-strand input to the forward strand before calling Ensembl: sent 11:5227002:5227002:1/A for 11:5227002:5227002:-1/T. Response alleles read on the forward strand.',
      );
      expect(readMarkdownText(contentText(reverse))).toContain(notice);
      expect((forward.structuredContent as Structured).notice).toBeUndefined();
    });

    it.each([
      [
        'a multi-base allele',
        '11:5227002:5227003:-1/TT',
        '11:5227002:5227003:1',
        'AA',
        '11 5227002 5227003 TC/AA 1',
        'TC/AA',
      ],
      [
        'an insertion',
        '11:5227003:5227002:-1/C',
        '11:5227003:5227002:1',
        'G',
        '11 5227003 5227002 -/G 1',
        '-/G',
      ],
      [
        'a deletion',
        '11:5227002:5227002:-1/-',
        '11:5227002:5227002:1',
        '-',
        '11 5227002 5227002 T/- 1',
        'T/-',
      ],
      [
        'a structural-variant duplication',
        '11:5227000:5228000:-1/DUP',
        '11:5227000:5228000:1',
        'DUP',
        '11 5227000 5228000 DUP 1',
        'duplication',
      ],
      [
        'a structural-variant deletion',
        '11:5227000:5228000:-1/DEL',
        '11:5227000:5228000:1',
        'DEL',
        '11 5227000 5228000 DEL 1',
        'deletion',
      ],
      [
        'a lowercase allele',
        '11:5227002:5227002:-1/t',
        '11:5227002:5227002:1',
        'A',
        '11 5227002 5227002 T/A 1',
        'T/A',
      ],
      [
        'a mixed-case multi-base allele',
        '11:5227002:5227004:-1/aAt',
        '11:5227002:5227004:1',
        'ATT',
        '11 5227002 5227004 TCA/ATT 1',
        'TCA/ATT',
      ],
      [
        'slash-separated alleles',
        '11:5227002:5227002:-1/T/C',
        '11:5227002:5227002:1',
        'A/G',
        '11 5227002 5227002 T/A 1',
        'T/A',
      ],
    ])(
      'sends %s as its forward-strand equivalent',
      async (_label, variant, region, allele, echo, alleleString) => {
        respondFrom(
          new Map([
            [
              regionUrl(region, allele),
              [hbbRecord({ input: echo, allele_string: alleleString, strand: 1 })],
            ],
          ]),
        );
        const reverse = await runToolContract(ensemblPredictVariant, { variant });
        const forward = await runToolContract(ensemblPredictVariant, {
          variant: `${region}/${allele}`,
        });

        expect(reverse.isError).toBeUndefined();
        expect(http.calls[0]?.request.url).toBe(regionUrl(region, allele));
        expect(resultsOf(reverse)).toEqual(resultsOf(forward));
        expect(resultsOf(reverse)).toMatchObject([{ alleleString, strand: 1 }]);
        expect((reverse.structuredContent as Structured).notice).toContain(
          `sent ${region}/${allele} for ${variant}.`,
        );
      },
    );

    it.each([
      ['11:5227002:5227002:1/a', '11:5227002:5227002:1', 'a'],
      ['11:5227002:5227003:1/AA', '11:5227002:5227003:1', 'AA'],
      ['11:5227000:5228000:1/DUP', '11:5227000:5228000:1', 'DUP'],
    ])('sends strand-1 input %s unchanged, with no notice', async (variant, region, allele) => {
      respondFrom(new Map([[regionUrl(region, allele), [hbbRecord({ strand: 1 })]]]));
      const result = await runToolContract(ensemblPredictVariant, { variant });

      expect(result.isError).toBeUndefined();
      expect(http.calls.map((call) => call.request.url)).toEqual([regionUrl(region, allele)]);
      expect((result.structuredContent as Structured).notice).toBeUndefined();
    });

    it('names the forward request when the forward allele matches the reference', async () => {
      http.route({
        match: VEP,
        respond: (request) =>
          Response.json(
            {
              error:
                request.url === regionUrl('11:5227002:5227002:1', 'T')
                  ? 'request for consequence of [T] matches reference [T]'
                  : `unrouted ${request.url}`,
            },
            { status: 400 },
          ),
      });
      const result = await runToolContract(ensemblPredictVariant, {
        variant: '11:5227002:5227002:-1/A',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'invalid_notation', recovery: { hint: recovery('invalid_notation') } },
        },
      });
      const message = (result.structuredContent as { error: { message: string } }).error.message;
      expect(message).toContain(
        'Invalid region+allele notation "11:5227002:5227002:-1/A" (sent as 11:5227002:5227002:1/T): request for consequence of [T] matches reference [T]',
      );
      expect(readMarkdownText(contentText(result))).toContain('(sent as 11:5227002:5227002:1/T)');
      expect(http.calls.map((call) => call.request.url)).toEqual([
        regionUrl('11:5227002:5227002:1', 'T'),
      ]);
    });
  });
});

describe('ensemblPredictVariant notice composition (issues #61, #66)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** HBB p.Glu7Val as a reverse-strand HGVS input reports it: record strand -1, colocated strand 1. */
  const reverseStrandRecord = (input: string): VepRecord => ({
    input,
    alleleString: 'A/T',
    strand: -1,
    chromosome: '11',
    start: 5227002,
    end: 5227002,
    transcriptConsequences: [
      {
        transcriptId: 'ENST00000335295',
        variantAllele: 'T',
        consequenceTerms: ['missense_variant'],
      },
      { transcriptId: 'ENST00000759072', variantAllele: 'T', consequenceTerms: ['intron_variant'] },
    ],
    colocatedVariants: [
      { id: 'CD830010', alleleString: 'HGMD_MUTATION', strand: 1 },
      { id: 'rs334', alleleString: 'T/A/C/G', strand: 1, pubmed: [1, 2, 3] },
    ],
  });

  const enrichmentOf = (ctx: ReturnType<typeof createMockContext>) =>
    getEnrichment(ctx) as { notice?: string; truncated?: boolean; shown?: number; cap?: number };

  const MISMATCH = 'ENST00000335295.4:c.20A>T (strand -1) vs colocated CD830010, rs334 (strand 1)';
  const NORMALIZED =
    'Converted the reverse-strand input to the forward strand before calling Ensembl: sent 11:5227002:5227002:1/A for 11:5227002:5227002:-1/T.';

  it('joins the strand-mismatch notice and the cap guidance in one notice', async () => {
    mockPredictVariantHgvs.mockResolvedValueOnce([
      reverseStrandRecord('ENST00000335295.4:c.20A>T'),
    ]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    await ensemblPredictVariant.handler(
      ensemblPredictVariant.input.parse({
        variant: 'ENST00000335295.4:c.20A>T',
        max_transcript_consequences: 1,
      }),
      ctx,
    );
    const { notice, truncated, shown, cap } = enrichmentOf(ctx);
    expect(notice).toBe(
      `Strands differ: ${MISMATCH}. Reverse-complement one side before matching variantAllele or alleleString against a colocated alleleString or clinicalSignificanceByAllele key. Showing 1 of 2 transcript consequences. Raise max_transcript_consequences (0 returns all) or set include_all_colocated_pubmed=true for the full detail.`,
    );
    expect({ truncated, shown, cap }).toEqual({ truncated: true, shown: 1, cap: 1 });
  });

  it('joins the normalization notice and the empty-result notice', async () => {
    mockPredictVariantRegion.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    await ensemblPredictVariant.handler(
      ensemblPredictVariant.input.parse({ variant: '11:5227002:5227002:-1/T' }),
      ctx,
    );
    expect(mockPredictVariantRegion).toHaveBeenCalledWith(
      '11',
      5227002,
      5227002,
      1,
      'A',
      'homo_sapiens',
      expect.anything(),
    );
    expect(enrichmentOf(ctx).notice).toBe(
      `${NORMALIZED} Response alleles read on the forward strand. No VEP results for "11:5227002:5227002:-1/T". Verify the notation format and that the position falls within an annotated region.`,
    );
  });

  it('joins normalization, strand mismatch, and both cap fragments in one notice', async () => {
    mockPredictVariantRegion.mockResolvedValueOnce([
      reverseStrandRecord('ENST00000335295.4:c.20A>T'),
    ]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    await ensemblPredictVariant.handler(
      ensemblPredictVariant.input.parse({
        variant: '11:5227002:5227002:-1/T',
        max_transcript_consequences: 1,
        max_pubmed_ids_per_variant: 2,
      }),
      ctx,
    );
    const { notice, truncated } = enrichmentOf(ctx);
    expect(notice).toBe(
      `${NORMALIZED} Response alleles read on the forward strand. Strands differ: ${MISMATCH}. Reverse-complement one side before matching variantAllele or alleleString against a colocated alleleString or clinicalSignificanceByAllele key. Showing 1 of 2 transcript consequences; capped PubMed IDs to 2 per colocated variant. Raise max_transcript_consequences (0 returns all) or set include_all_colocated_pubmed=true for the full detail.`,
    );
    expect(truncated).toBe(true);
  });

  it('names every record whose strand differs from a colocated strand', async () => {
    mockPredictVariantHgvs.mockResolvedValueOnce([
      reverseStrandRecord('first'),
      { ...reverseStrandRecord('second'), strand: 1 },
      {
        ...reverseStrandRecord('third'),
        colocatedVariants: [{ strand: 1 }, { id: 'rsX', strand: 2 }, { id: 'rsY', strand: -1 }],
      },
      { ...reverseStrandRecord('fourth'), input: undefined },
    ]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    await ensemblPredictVariant.handler(
      ensemblPredictVariant.input.parse({ variant: 'ENST00000335295.4:c.20A>T' }),
      ctx,
    );
    expect(enrichmentOf(ctx).notice).toContain(
      'Strands differ: first (strand -1) vs colocated CD830010, rs334 (strand 1); third (strand -1) vs colocated an unnamed variant (strand 1), rsX (strand 2); record 4 (strand -1) vs colocated CD830010, rs334 (strand 1).',
    );
  });

  it.each([
    ['the strands agree', { strand: 1 }],
    ['the record reports no strand', { strand: undefined }],
    [
      'no colocated variant reports a strand',
      { colocatedVariants: [{ id: 'rs334', alleleString: 'T/A/C/G' }] },
    ],
  ])('raises no strand notice when %s', async (_label, fields) => {
    mockPredictVariantHgvs.mockResolvedValueOnce([
      { ...reverseStrandRecord('ENST00000335295.4:c.20A>T'), ...fields },
    ]);
    const ctx = createMockContext({ errors: ensemblPredictVariant.errors });
    await ensemblPredictVariant.handler(
      ensemblPredictVariant.input.parse({ variant: 'ENST00000335295.4:c.20A>T' }),
      ctx,
    );
    expect(enrichmentOf(ctx).notice).toBeUndefined();
  });

  it('describes every allele as reading on its own record strand', () => {
    const record = ensemblPredictVariant.output.shape.results.element.shape;
    const consequence = record.transcriptConsequences.element.shape;
    const colocated = record.colocatedVariants.element.shape;
    expect(record.alleleString.description).toContain("record's strand");
    expect(consequence.variantAllele.description).toContain("record's strand");
    expect(consequence.variantAllele.description).toContain(
      "whatever this transcript's own strand",
    );
    expect(colocated.alleleString.description).toContain('its own strand');
    expect(record.strand.description).toContain('its alleleString and every variantAllele');
    expect(colocated.strand.description).toContain(
      'its alleleString and clinicalSignificanceByAllele keys',
    );
  });
});

describe('ensemblPredictVariant reverse-strand normalization timing (issue #66)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredictVariantRegion.mockResolvedValue([]);
    mockPredictVariantHgvs.mockResolvedValue([]);
  });

  const BASE = 5_000;
  const PREFIX = '11:5227002:5227002:-1/';

  /** Thread CPU time (µs) per handler call, over a batch holding ~320k characters of input. */
  const perCallMicros = async (variant: string, size: number) => {
    const input = ensemblPredictVariant.input.parse({ variant });
    const ctxs = Array.from({ length: Math.max(1, Math.round((BASE * 64) / size)) }, () =>
      createMockContext({ errors: ensemblPredictVariant.errors }),
    );
    const start = process.threadCpuUsage();
    for (const ctx of ctxs) await ensemblPredictVariant.handler(input, ctx);
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / ctxs.length;
  };

  it.each([
    ['a long nucleotide run', (n: number) => 'ACGT'.repeat(n / 4)],
    ['a nucleotide run ending in a non-base', (n: number) => `${'ACGT'.repeat(n / 4 - 1)}ACGX`],
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])(
    'routes and normalizes %s in linear time',
    async (_label, allele) => {
      await perCallMicros(PREFIX + allele(BASE), BASE); // warm-up
      let leastLargest = Number.POSITIVE_INFINITY;
      for (let size = BASE * 2; size <= BASE * 64; size *= 2) {
        let growth = Number.POSITIVE_INFINITY;
        for (let rep = 0; rep < 5; rep++) {
          const small = await perCallMicros(PREFIX + allele(BASE), BASE);
          const large = await perCallMicros(PREFIX + allele(size), size);
          growth = Math.min(growth, large / Math.max(small, 1));
          if (size === BASE * 64) leastLargest = Math.min(leastLargest, large);
        }
        // Linear growth tracks size/BASE; 4x that stays far below quadratic (size/BASE)^2.
        expect(growth).toBeLessThan(4 * (size / BASE));
      }
      expect(leastLargest).toBeLessThan(250_000);
    },
    0,
  );
});
