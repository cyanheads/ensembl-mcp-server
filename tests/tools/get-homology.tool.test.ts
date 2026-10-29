/**
 * @fileoverview Tests for the ensembl_get_homology tool.
 * @module tests/tools/get-homology.tool.test
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
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblGetHomology } from '@/mcp-server/tools/definitions/get-homology.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { HomologyEntry } from '@/services/ensembl/types.js';

const mockGetHomologyBySymbol = vi.fn();
const mockGetHomologyById = vi.fn();

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
            getHomologyBySymbol: mockGetHomologyBySymbol,
            getHomologyById: mockGetHomologyById,
            getHomologyTargetSymbols: async () => new Map<string, string>(),
          },
  };
});

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

  it('formats empty homology results, leaving the guidance to the notice', () => {
    const output = {
      homologs: [],
      totalCount: 0,
      queryId: BRCA2_ID,
      querySpecies: 'homo_sapiens',
      queryType: 'orthologues',
    };
    const blocks = ensemblGetHomology.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text.split('\n')).toContain('No homologs found.');
    expect(text).not.toContain('target_species');
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
    const result = await runToolContract(ensemblGetHomology, { symbol: 'FAKEGENE' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'not_found',
          recovery: {
            hint: ensemblGetHomology.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
        },
      },
    });
  });
});

describe('ensemblGetHomology blank species (issue #22)', () => {
  it.each(['', '   '])(
    'rejects species %j as invalid_arguments before any request',
    async (species) => {
      mockGetHomologyBySymbol.mockClear();
      mockGetHomologyById.mockClear();
      const result = await runToolContract(ensemblGetHomology, { symbol: 'BRCA2', species });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(mockGetHomologyBySymbol).not.toHaveBeenCalled();
      expect(mockGetHomologyById).not.toHaveBeenCalled();
    },
  );

  it('still accepts a blank optional target_species', async () => {
    mockGetHomologyBySymbol.mockClear();
    mockGetHomologyBySymbol.mockResolvedValueOnce({
      homologs: [mouseOrtholog],
      resolvedQueryId: 'ENSG00000139618',
    });
    const result = await runToolContract(ensemblGetHomology, {
      symbol: 'BRCA2',
      target_species: '',
    });
    expect(result.isError).toBeUndefined();
    expect(mockGetHomologyBySymbol).toHaveBeenCalledTimes(1);
  });
});

describe('ensemblGetHomology through EnsemblService (issues #34, #37)', () => {
  const HOMOLOGY = /^https:\/\/rest\.ensembl\.org\/homology\//;
  const unknownSpecies = (name: string) => `Can not find internal name for species '${name}'`;
  let http: FetchMockHarness;

  beforeEach(() => {
    upstream.real = true;
    // Strict: an unrouted request throws, so an unexpected upstream call fails the test.
    http = createFetchMock();
    http.route({ match: 'https://rest.ensembl.org/lookup/id', respond: () => Response.json({}) });
    http.install();
    initEnsemblService({} as AppConfig, createInMemoryStorage());
  });

  afterEach(() => {
    http.restore();
    upstream.real = false;
  });

  const recovery = (reason: string) =>
    ensemblGetHomology.errors!.find((e) => e.reason === reason)!.recovery;

  /** Concatenated text of every `content[]` block — what a `content`-only client reads. */
  const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

  const rejectWith = (error: string) =>
    http.route({ match: HOMOLOGY, respond: () => Response.json({ error }, { status: 400 }) });

  it.each([
    [
      'species on the symbol path',
      { symbol: 'BRCA2', species: 'not_a_species' },
      'species',
      'not_a_species',
    ],
    [
      'species on the ID path',
      { id: 'ENSG00000139618', species: 'not_a_species' },
      'species',
      'not_a_species',
    ],
    [
      'target_species on the ID path',
      { id: 'ENSG00000139618', target_species: 'not_a_target' },
      'target_species',
      'not_a_target',
    ],
    [
      'name given as both species and target_species',
      { id: 'ENSG00000139618', species: 'not_a_species', target_species: 'not_a_species' },
      'species',
      'not_a_species',
    ],
  ])('maps an unknown %s to invalid_species', async (_label, args, field, name) => {
    rejectWith(unknownSpecies(name));
    const result = await runToolContract(ensemblGetHomology, args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'invalid_species', recovery: { hint: recovery('invalid_species') } },
      },
    });
    expect(recovery('invalid_species')).toContain('ensembl_list_species');
    const text = contentText(result);
    expect(text).toContain(`Error: ${field} "${name}"`);
    expect(text).toContain('(reason invalid_species)');
    expect(http.calls).toHaveLength(1);
  });

  it('keeps the bare species-name envelope for an unknown symbol as not_found', async () => {
    // Ensembl answers an unknown symbol with {"error":"<species>"} on HTTP 400.
    rejectWith('homo_sapiens');
    const result = await runToolContract(ensemblGetHomology, { symbol: 'NOTAGENEXYZ' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'not_found', recovery: { hint: recovery('not_found') } },
      },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('maps an empty data array for an unknown ID to not_found (#40)', async () => {
    // Ensembl answers an ID it does not hold in the source species with HTTP 200 {"data":[]}.
    http.route({ match: HOMOLOGY, respond: () => Response.json({ data: [] }) });
    const result = await runToolContract(ensemblGetHomology, { id: 'ENSG99999999999' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'not_found', recovery: { hint: recovery('not_found') } },
      },
    });
    const text = contentText(result);
    expect(text).toContain('Gene ID "ENSG99999999999" not found in homo_sapiens');
    expect(text).toContain('(reason not_found)');
    expect(http.calls).toHaveLength(1);
  });

  /** Mirrors Ensembl: a versioned stable ID answers {"data":[]}, the bare one its own entry. */
  const routeVersionAware = () =>
    http.route({
      match: HOMOLOGY,
      respond: (request) => {
        const id = new URL(request.url).pathname.split('/').pop() ?? '';
        if (/^ENS\w*\.\d+$/i.test(id)) return Response.json({ data: [] });
        return Response.json({
          data: [
            {
              id,
              homologies: [
                {
                  type: 'ortholog_one2one',
                  target: { id: 'ENSMUSG00000041147', species: 'mus_musculus', perc_id: 58.6 },
                },
              ],
            },
          ],
        });
      },
    });

  it.each([
    ['ENSG00000139618.17', 'ENSG00000139618'],
    ['ensg00000139618.19', 'ensg00000139618'],
    ['ENSMUSG00000041147.4', 'ENSMUSG00000041147'],
  ])('strips the version from %s before the request (#41)', async (submitted, bare) => {
    routeVersionAware();
    const result = await runToolContract(ensemblGetHomology, {
      id: submitted,
      target_species: 'mus_musculus',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      queryId: bare,
      totalCount: 1,
      homologs: [{ targetId: 'ENSMUSG00000041147', targetSpecies: 'mus_musculus' }],
    });
    expect(contentText(result)).toContain(`## Homologs of ${bare} (homo_sapiens)`);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]?.request.url).toBe(
      `https://rest.ensembl.org/homology/id/homo_sapiens/${bare}?type=orthologues&target_species=mus_musculus`,
    );
  });

  it.each([
    ['a dotted non-ENS ID', 'arabidopsis_thaliana', 'AT3G52430.1'],
    ['an ENS ID whose number is not 11 digits', 'homo_sapiens', 'ENSG0013961.17'],
  ])('forwards %s unchanged (#41)', async (_label, species, id) => {
    routeVersionAware();
    await runToolContract(ensemblGetHomology, { id, species });
    expect(http.calls[0]?.request.url).toBe(
      `https://rest.ensembl.org/homology/id/${species}/${id}?type=orthologues`,
    );
  });

  it('checks a long ID for a version suffix in linear time (#41)', async () => {
    // An unbroken uppercase run after ENS never reaches the digits, so every start fails.
    http.route({ match: HOMOLOGY, respond: () => Response.json({ data: [] }) });
    const cpuMicros = async (size: number) => {
      const id = `ENS${'A'.repeat(size)}.1`;
      const start = process.threadCpuUsage();
      const result = await runToolContract(ensemblGetHomology, { id });
      const used = process.threadCpuUsage(start);
      expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'not_found' } } });
      return used.user + used.system;
    };
    await cpuMicros(5_000); // warm-up
    const small = await cpuMicros(5_000);
    const large = await cpuMicros(320_000);
    // 64x the input: linear stays near 64x, quadratic would be ~4096x.
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(250_000);
  });

  it('keeps an empty success with its notice for a known gene with no homologs (#40)', async () => {
    http.route({
      match: HOMOLOGY,
      respond: () => Response.json({ data: [{ id: 'ENSG00000139618', homologies: [] }] }),
    });
    const result = await runToolContract(ensemblGetHomology, {
      id: 'ENSG00000139618',
      target_species: 'saccharomyces_cerevisiae',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      homologs: [],
      totalCount: 0,
      queryId: 'ENSG00000139618',
      querySpecies: 'homo_sapiens',
      queryType: 'orthologues',
      notice:
        'No orthologues found for "ENSG00000139618" in homo_sapiens targeting ' +
        'saccharomyces_cerevisiae. Try type=all or remove the target_species filter.',
    });
    const { notice } = result.structuredContent as { notice: string };
    const lines = contentText(result).split('\n');
    expect(lines).toContain('No homologs found.');
    expect(lines).toContain(`> ${escapeMarkdownInline(notice)}`);
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/homology/id/homo_sapiens/ENSG00000139618?type=orthologues&target_species=saccharomyces_cerevisiae',
    );
  });

  it('suggests only type=all for no homologs when no target_species was set', async () => {
    http.route({
      match: HOMOLOGY,
      respond: () => Response.json({ data: [{ id: 'ENSG00000139618', homologies: [] }] }),
    });
    const result = await runToolContract(ensemblGetHomology, { id: 'ENSG00000139618' });

    expect(result.structuredContent).toMatchObject({
      homologs: [],
      notice: 'No orthologues found for "ENSG00000139618" in homo_sapiens. Try type=all.',
    });
    expect(contentText(result)).not.toContain('target_species');
  });

  /** Upstream URLs of the homology requests the call sent, in order. */
  const homologyUrls = () =>
    http.calls
      .map((call) => new URL(call.request.url))
      .filter((url) => url.origin === 'https://rest.ensembl.org')
      .filter((url) => url.pathname.startsWith('/homology/'))
      .map(String);
  const membershipReads = () =>
    http.calls.filter(
      (call) => new URL(call.request.url).pathname === '/info/compara/species_sets/PROTEIN_TREES',
    ).length;

  it('sends one homology request when the target is in the source species’ comparison (#55)', async () => {
    http.route({
      match: HOMOLOGY,
      respond: () =>
        Response.json({
          data: [
            {
              id: TP53_ID,
              homologies: [
                {
                  type: 'ortholog_one2many',
                  taxonomy_level: 'Bilateria',
                  target: { id: 'FBgn0039044', species: 'drosophila_melanogaster' },
                },
              ],
            },
          ],
        }),
    });
    for (const args of [
      { id: TP53_ID, target_species: 'drosophila_melanogaster' },
      { id: TP53_ID },
    ]) {
      const result = await runToolContract(ensemblGetHomology, args);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        homologs: [{ targetId: 'FBgn0039044', taxonomyLevel: 'Bilateria' }],
      });
      expect(String((result.structuredContent as { notice?: string }).notice)).not.toContain(
        'pan-taxonomic',
      );
    }
    expect(homologyUrls()).toEqual([
      `https://rest.ensembl.org/homology/id/homo_sapiens/${TP53_ID}?type=orthologues&target_species=drosophila_melanogaster`,
      `https://rest.ensembl.org/homology/id/homo_sapiens/${TP53_ID}?type=orthologues`,
    ]);
    expect(membershipReads()).toBe(0);
  });

  describe('target outside the source species’ comparison (#55)', () => {
    const FLY_GENE = 'FBgn0039044';
    const HUMAN_TARGETS = ['ENSG00000078900', 'ENSG00000141510', 'ENSG00000073282'];
    const PAN_NOTICE =
      "homo_sapiens is outside the homology comparison Ensembl runs for drosophila_melanogaster, so this answer comes from Ensembl's pan-taxonomic comparison (pan_homology), whose taxonomyLevel can name a broader clade than the two species' last common ancestor.";
    const ensemblUrl = (request: Request) => {
      const url = new URL(request.url);
      return url.origin === 'https://rest.ensembl.org' ? url : undefined;
    };

    beforeEach(() => {
      http.route(
        {
          match: (request) =>
            ensemblUrl(request)?.pathname === '/info/compara/species_sets/PROTEIN_TREES',
          respond: () =>
            Response.json([
              {
                species_set_group: 'collection-default',
                method: 'PROTEIN_TREES',
                species_set: ['drosophila_melanogaster', 'homo_sapiens', 'arabidopsis_thaliana'],
              },
            ]),
        },
        {
          // The source's own comparison misses the target; the pan-taxonomic one answers.
          match: (request) => ensemblUrl(request)?.pathname.startsWith('/homology/') === true,
          respond: (request) => {
            const params = new URL(request.url).searchParams;
            if (params.get('compara') !== 'pan_homology') {
              const target = params.get('target_species');
              return Response.json(
                { error: `Could not find a GenomeDB named '${target}'` },
                { status: 400 },
              );
            }
            // A gene outside the pan-taxonomic trees answers no data.
            if (params.get('target_species') === 'arabidopsis_thaliana') {
              return Response.json({ data: [] });
            }
            return Response.json({
              data: [
                {
                  id: FLY_GENE,
                  homologies: HUMAN_TARGETS.map((id) => ({
                    type: 'ortholog_one2many',
                    taxonomy_level: 'Metazoa',
                    target: { id, species: 'homo_sapiens', perc_id: 14.7583 },
                  })),
                },
              ],
            });
          },
        },
      );
    });

    it.each([
      ['id', { id: FLY_GENE }, `/homology/id/drosophila_melanogaster/${FLY_GENE}`],
      ['symbol', { symbol: 'p53' }, '/homology/symbol/drosophila_melanogaster/p53'],
    ])(
      'answers by %s from the pan-taxonomic comparison with its notice on both surfaces',
      async (_mode, args, path) => {
        const result = await runToolContract(ensemblGetHomology, {
          ...args,
          species: 'drosophila_melanogaster',
          target_species: 'homo_sapiens',
        });

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          queryId: FLY_GENE,
          querySpecies: 'drosophila_melanogaster',
          totalCount: 3,
          notice: expect.stringMatching(/^homo_sapiens is outside the homology comparison/),
        });
        const { homologs, notice } = result.structuredContent as {
          homologs: Array<{ targetId: string }>;
          notice: string;
        };
        expect(homologs.map((h) => h.targetId)).toEqual(HUMAN_TARGETS);
        expect(notice.startsWith(`${PAN_NOTICE} `)).toBe(true);
        const lines = contentText(result).split('\n');
        expect(lines).toContain('### ENSG00000141510');
        expect(lines).toContain('**Last common ancestor:** Metazoa');
        expect(lines).toContain(`> ${escapeMarkdownInline(notice)}`);
        expect(homologyUrls()).toEqual([
          `https://rest.ensembl.org${path}?type=orthologues&target_species=homo_sapiens`,
          `https://rest.ensembl.org${path}?type=orthologues&target_species=homo_sapiens&compara=pan_homology`,
        ]);
        expect(membershipReads()).toBe(1);
      },
    );

    it('composes the pan-taxonomic notice with the cap guidance', async () => {
      const result = await runToolContract(ensemblGetHomology, {
        id: FLY_GENE,
        species: 'drosophila_melanogaster',
        target_species: 'homo_sapiens',
        max_results: 1,
      });
      expect(result.structuredContent).toMatchObject({ truncated: true, shown: 1, cap: 1 });
      const { notice } = result.structuredContent as { notice: string };
      expect(notice.startsWith(`${PAN_NOTICE} Showing 1 of 3 homologs. `)).toBe(true);
      expect(contentText(result).split('\n')).toContain(`> ${escapeMarkdownInline(notice)}`);
    });

    it('answers an empty pan-taxonomic result as no homologs, not as an unknown gene', async () => {
      const result = await runToolContract(ensemblGetHomology, {
        id: FLY_GENE,
        species: 'drosophila_melanogaster',
        target_species: 'arabidopsis_thaliana',
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        homologs: [],
        totalCount: 0,
        queryId: FLY_GENE,
        notice:
          "arabidopsis_thaliana is outside the homology comparison Ensembl runs for drosophila_melanogaster, so this answer comes from Ensembl's pan-taxonomic comparison (pan_homology), whose taxonomyLevel can name a broader clade than the two species' last common ancestor. " +
          `No orthologues found for "${FLY_GENE}" in drosophila_melanogaster targeting arabidopsis_thaliana. Try type=all or remove the target_species filter.`,
      });
    });

    it('fails target_not_compared with its recovery when a species is outside that comparison', async () => {
      const result = await runToolContract(ensemblGetHomology, {
        id: FLY_GENE,
        species: 'drosophila_melanogaster',
        target_species: 'rattus_norvegicus',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: {
            reason: 'target_not_compared',
            recovery: { hint: recovery('target_not_compared') },
          },
        },
      });
      const text = contentText(result);
      expect(text).toContain(
        "Error: rattus_norvegicus is outside the homology comparison Ensembl runs for drosophila_melanogaster, and Ensembl's pan-taxonomic comparison does not list rattus_norvegicus among its species, which it names in Ensembl's internal form (homo_sapiens).",
      );
      expect(text).toContain(`Recovery: ${recovery('target_not_compared')}`);
      expect(text).toContain('(reason target_not_compared');
      expect(homologyUrls()).toHaveLength(1);
      expect(membershipReads()).toBe(1);
    });

    it('still maps an unknown target_species to invalid_species with one request', async () => {
      http.reset();
      rejectWith("Can not find internal name for species 'not_a_species'");
      const result = await runToolContract(ensemblGetHomology, {
        id: FLY_GENE,
        species: 'drosophila_melanogaster',
        target_species: 'not_a_species',
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_species' } },
      });
      expect(http.calls).toHaveLength(1);
    });
  });

  it('describes percId and percPos over the target protein’s length (#54)', () => {
    const row = ensemblGetHomology.output.shape.homologs.element.shape;
    for (const field of [row.percId, row.percPos]) {
      expect(field.description).toContain("target protein's length");
      expect(field.description).not.toContain('between the query and target');
    }
    expect(row.percId.description).toContain(
      "identical positions divided by the target protein's length",
    );
    expect(ensemblGetHomology.description).toContain("over the target protein's length");
  });

  it('classifies a long echoed rejection in linear time', async () => {
    const unit = 'can not find internal name for specie ';
    const cpuMicros = async (size: number) => {
      const error = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      http.route({
        match: HOMOLOGY,
        once: true,
        respond: () => Response.json({ error }, { status: 400 }),
      });
      const start = process.threadCpuUsage();
      const result = await runToolContract(ensemblGetHomology, { id: 'ENSG00000139618' });
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
});
