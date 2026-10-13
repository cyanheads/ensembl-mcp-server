/**
 * @fileoverview Tests for EnsemblService normalization and endpoint routing.
 * Fixtures mirror live rest.ensembl.org response shapes.
 * @module tests/services/ensembl-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblGetHomology } from '@/mcp-server/tools/definitions/get-homology.tool.js';
import { ensemblGetSequence } from '@/mcp-server/tools/definitions/get-sequence.tool.js';
import { ensemblGetXrefs } from '@/mcp-server/tools/definitions/get-xrefs.tool.js';
import { ensemblListSpecies } from '@/mcp-server/tools/definitions/list-species.tool.js';
import { ensemblLookupGene } from '@/mcp-server/tools/definitions/lookup-gene.tool.js';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import { ensemblQueryRegion } from '@/mcp-server/tools/definitions/query-region.tool.js';
import {
  ENSEMBL_ATTEMPT_TIMEOUT_MS,
  ENSEMBL_CALL_DEADLINE_MS,
  getEnsemblService,
  initEnsemblService,
} from '@/services/ensembl/ensembl-service.js';

const mockFetch = vi.fn();

/** Build a minimal fetch Response stub carrying a JSON body, matching what fetchJson reads. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Rejects with the signal's reason once it aborts — how a real fetch settles an aborted request. */
function onAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** An upstream that accepts the connection and never sends response headers. */
const stalledFetch = (_url: string, init: RequestInit) => onAbort(init.signal!);

/** An upstream that sends its headers at once and then never finishes the body. */
const stalledBodyFetch = async (_url: string, init: RequestInit) =>
  ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: () => onAbort(init.signal!),
  }) as unknown as Response;

/** An HTML error page, which fetchJson classifies as a retryable ServiceUnavailable. */
const htmlPage = () =>
  ({
    status: 503,
    ok: false,
    headers: { get: () => null },
    text: async () => '<!DOCTYPE html><html><body>Service Unavailable</body></html>',
  }) as unknown as Response;

/** Settles a promise into a value or an error, recording the fake-clock time it settled at. */
function track<T>(promise: Promise<T>) {
  const startedAt = Date.now();
  const state: { settledAt?: number; value?: T; error?: unknown } = {};
  const done = promise.then(
    (value) => {
      state.settledAt = Date.now() - startedAt;
      state.value = value;
    },
    (error: unknown) => {
      state.settledAt = Date.now() - startedAt;
      state.error = error;
    },
  );
  return { state, done };
}

/** Ensembl's outage envelopes, as its REST server reports a lost database connection. */
const OUTAGE_ENVELOPES = [
  'Could not connect to database homo_sapiens_core_115_38 as user anonymous using ' +
    '[DBI:mysql:database=homo_sapiens_core_115_38;host=mysql-ens-sta-1.ebi.ac.uk;port=4519] ' +
    'as a locator:\nUnknown MySQL server host',
  "DBI connect('database=homo_sapiens_core_115_38;host=mysql-ens-sta-1;port=4519','anonymous',...) " +
    'failed: Too many connections at /nfs/public/release/ensweb/modules/Bio/EnsEMBL/DBSQL/DBConnection.pm line 288.',
];

/** Every tool, on each of its upstream paths. */
const TOOL_CALLS = [
  ['ensembl_lookup_gene (symbol)', ensemblLookupGene, { symbol: 'BRCA2' }],
  ['ensembl_lookup_gene (id)', ensemblLookupGene, { id: 'ENSG00000139618' }],
  ['ensembl_lookup_gene (ids)', ensemblLookupGene, { ids: ['ENSG00000139618'] }],
  ['ensembl_get_sequence (id)', ensemblGetSequence, { id: 'ENSG00000139618' }],
  [
    'ensembl_get_sequence (region)',
    ensemblGetSequence,
    { id: '13:32315086-32315100', species: 'homo_sapiens' },
  ],
  ['ensembl_query_region', ensemblQueryRegion, { species: 'homo_sapiens', region: '13:1-1000' }],
  [
    'ensembl_predict_variant (region)',
    ensemblPredictVariant,
    { variant: '7:140753336:140753336:1/T' },
  ],
  [
    'ensembl_predict_variant (hgvs)',
    ensemblPredictVariant,
    { variant: 'ENST00000380152.8:c.2T>A' },
  ],
  ['ensembl_predict_variant (rsID)', ensemblPredictVariant, { variant: 'rs334' }],
  ['ensembl_get_homology (symbol)', ensemblGetHomology, { symbol: 'BRCA2' }],
  ['ensembl_get_homology (id)', ensemblGetHomology, { id: 'ENSG00000139618' }],
  ['ensembl_get_xrefs', ensemblGetXrefs, { id: 'ENSG00000139618' }],
  ['ensembl_list_species', ensemblListSpecies, {}],
] as const;

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;
const runTool = (def: unknown, args: unknown): Promise<ToolResult> =>
  runToolContract(def as typeof ensemblGetXrefs, args as never);
const errorOf = (result: ToolResult) =>
  (
    result.structuredContent as {
      error: { code: number; message: string; data?: Record<string, unknown> };
    }
  ).error;

describe('EnsemblService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    // Any request a test did not script fails loudly instead of resolving undefined.
    mockFetch.mockImplementation(async (url: string) => {
      throw new Error(`Unmocked fetch: ${url}`);
    });
    initEnsemblService({} as AppConfig, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('queryRegion exon normalization (issue #9)', () => {
    // Mirrors the raw /overlap/region/.../feature=exon shape: the same exon id is
    // returned once per parent transcript it belongs to, each row carrying Parent + rank.
    const rawExonOverlap = [
      {
        exon_id: 'ENSE00003856928',
        id: 'ENSE00003856928',
        Parent: 'ENST00000544455',
        rank: 1,
        constitutive: 0,
        ensembl_phase: -1,
        ensembl_end_phase: -1,
        start: 32315086,
        end: 32315145,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
        source: 'havana',
        version: 1,
      },
      {
        exon_id: 'ENSE00001484009',
        id: 'ENSE00001484009',
        Parent: 'ENST00000544455',
        rank: 2,
        start: 32316422,
        end: 32316527,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
      },
      {
        exon_id: 'ENSE00001484009',
        id: 'ENSE00001484009',
        Parent: 'ENST00000380152',
        rank: 2,
        start: 32316422,
        end: 32316527,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
      },
      {
        exon_id: 'ENSE00001484009',
        id: 'ENSE00001484009',
        Parent: 'ENST00000666593',
        rank: 2,
        start: 32316422,
        end: 32316527,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
      },
    ];

    it('surfaces a distinct parent transcript for each repeated exon row', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(rawExonOverlap));
      const ctx = createMockContext();
      const features = await getEnsemblService().queryRegion(
        'homo_sapiens',
        '13:32315086-32317000',
        ['exon'],
        undefined,
        ctx,
      );

      const repeated = features.filter((f) => f.id === 'ENSE00001484009');
      expect(repeated).toHaveLength(3);
      // The repeated exon id is not a duplicate — each row is discriminated by parentId.
      const parents = repeated.map((f) => f.parentId);
      expect(new Set(parents).size).toBe(3);
      expect(parents).toEqual(
        expect.arrayContaining(['ENST00000544455', 'ENST00000380152', 'ENST00000666593']),
      );
      // rank is carried through from the raw payload.
      expect(repeated.every((f) => f.rank === 2)).toBe(true);
    });

    it('maps raw Parent/rank onto parentId/rank', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([rawExonOverlap[0]]));
      const ctx = createMockContext();
      const [feature] = await getEnsemblService().queryRegion(
        'homo_sapiens',
        '13:32315086-32317000',
        ['exon'],
        undefined,
        ctx,
      );
      expect(feature?.parentId).toBe('ENST00000544455');
      expect(feature?.rank).toBe(1);
      expect(feature?.featureType).toBe('exon');
    });
  });

  describe('queryRegion assembly_name mapping (issue #23)', () => {
    it('maps a row assembly_name onto assemblyName and leaves regulatory rows without one', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'ENSG00000244734',
            feature_type: 'gene',
            seq_region_name: '11',
            start: 5225464,
            end: 5229395,
            strand: -1,
            assembly_name: 'GRCh38',
          },
          {
            id: 'ENSR1_C4ND',
            feature_type: 'regulatory',
            seq_region_name: '1',
            start: 999971,
            end: 1001148,
            strand: 0,
            description: 'promoter',
          },
        ]),
      );
      const [gene, regulatory] = await getEnsemblService().queryRegion(
        'homo_sapiens',
        '11:5225000-5230000',
        ['gene', 'regulatory'],
        undefined,
        createMockContext(),
      );
      expect(gene?.assemblyName).toBe('GRCh38');
      expect(regulatory).not.toHaveProperty('assemblyName');
    });
  });

  describe('getDefaultAssemblyName (issue #23)', () => {
    const assemblyInfo = (version: string, patch: string) => ({
      assembly_name: patch,
      default_coord_system_version: version,
      assembly_accession: 'GCA_000001405.29',
      top_level_region: [],
    });

    it('reads default_coord_system_version, not the patch-level assembly_name', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(assemblyInfo('GRCh38', 'GRCh38.p14')));
      const name = await getEnsemblService().getDefaultAssemblyName(
        'homo_sapiens',
        createMockContext(),
      );
      expect(name).toBe('GRCh38');
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        'https://rest.ensembl.org/info/assembly/homo_sapiens',
      );
    });

    it('caches per species for the process — one request per species ever queried', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('GRCh38', 'GRCh38.p14')))
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('GRCm39', 'GRCm39')));
      const service = getEnsemblService();
      const ctx = createMockContext();
      expect(await service.getDefaultAssemblyName('homo_sapiens', ctx)).toBe('GRCh38');
      expect(await service.getDefaultAssemblyName('homo_sapiens', ctx)).toBe('GRCh38');
      expect(await service.getDefaultAssemblyName('mus_musculus', ctx)).toBe('GRCm39');
      expect(await service.getDefaultAssemblyName('mus_musculus', ctx)).toBe('GRCm39');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed lookup — the next call asks again', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({ error: "Can not find internal name for species 'x'" }),
        )
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('GRCh37', 'GRCh37.p13')));
      const service = getEnsemblService();
      const ctx = createMockContext();
      await expect(service.getDefaultAssemblyName('homo_sapiens', ctx)).rejects.toThrow(
        'Can not find internal name',
      );
      expect(await service.getDefaultAssemblyName('homo_sapiens', ctx)).toBe('GRCh37');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('fails, uncached, when the response carries no default_coord_system_version', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ assembly_name: 'GRCh38.p14' }))
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('GRCh38', 'GRCh38.p14')));
      const service = getEnsemblService();
      const ctx = createMockContext();
      await expect(service.getDefaultAssemblyName('homo_sapiens', ctx)).rejects.toThrow(
        'default_coord_system_version',
      );
      expect(await service.getDefaultAssemblyName('homo_sapiens', ctx)).toBe('GRCh38');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('predictVariantId (issue #11)', () => {
    it('hits the VEP /id endpoint and normalizes the record', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'rs334',
            input: 'rs334',
            most_severe_consequence: 'missense_variant',
            seq_region_name: '11',
            start: 5227002,
            end: 5227002,
            assembly_name: 'GRCh38',
            transcript_consequences: [
              {
                gene_symbol: 'HBB',
                consequence_terms: ['missense_variant'],
                impact: 'MODERATE',
                amino_acids: 'E/V',
              },
            ],
            colocated_variants: [{ id: 'rs334', allele_string: 'T/A' }],
          },
        ]),
      );
      const ctx = createMockContext();
      const records = await getEnsemblService().predictVariantId('rs334', 'homo_sapiens', ctx);

      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('/vep/homo_sapiens/id/rs334');
      expect(records).toHaveLength(1);
      expect(records[0]?.mostSevereConsequence).toBe('missense_variant');
      expect(records[0]?.transcriptConsequences[0]?.geneSymbol).toBe('HBB');
      expect(records[0]?.transcriptConsequences[0]?.impact).toBe('MODERATE');
    });
  });

  describe('getSequenceById expand params (issue #13)', () => {
    const seqBody = { id: 'ENSG00000139618', seq: 'ACGTACGT', molecule: 'dna' };

    it('appends expand_5prime/expand_3prime for genomic stable-ID lookups', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(seqBody));
      const ctx = createMockContext();
      await getEnsemblService().getSequenceById('ENSG00000139618', 'genomic', 10, 10, ctx);

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('/sequence/id/ENSG00000139618');
      expect(url).toContain('type=genomic');
      expect(url).toContain('expand_5prime=10');
      expect(url).toContain('expand_3prime=10');
    });

    it('omits expand params when both are zero', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(seqBody));
      const ctx = createMockContext();
      await getEnsemblService().getSequenceById('ENSG00000139618', 'genomic', 0, 0, ctx);

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('type=genomic');
      expect(url).not.toContain('expand_5prime');
      expect(url).not.toContain('expand_3prime');
    });

    it('does not append expand params for non-genomic types', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'ENST00000380152', seq: 'MPEEK' }));
      const ctx = createMockContext();
      await getEnsemblService().getSequenceById('ENST00000380152', 'protein', 10, 10, ctx);

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('type=protein');
      expect(url).not.toContain('expand_5prime');
      expect(url).not.toContain('expand_3prime');
    });
  });

  describe('sequence molecule (issue #30)', () => {
    it('carries the molecule Ensembl returned, not the requested type', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'ENSP00000369497', molecule: 'protein', seq: 'MPIGSKERPT' }),
      );
      const record = await getEnsemblService().getSequenceById(
        'ENSP00000369497',
        'cdna',
        0,
        0,
        createMockContext(),
      );
      expect(record).toMatchObject({ type: 'cdna', molecule: 'protein', length: 10 });
    });

    it('carries the region molecule and omits it when Ensembl sends none', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({ id: 'chromosome:GRCh38:MT:1:4:1', molecule: 'dna', seq: 'GATC' }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'ENST00000380152', seq: 'ACGT' }));
      const ctx = createMockContext();
      const region = await getEnsemblService().getSequenceByRegion(
        'homo_sapiens',
        'MT:1-4',
        0,
        0,
        ctx,
      );
      expect(region).toMatchObject({ type: 'genomic', molecule: 'dna' });
      const bare = await getEnsemblService().getSequenceById('ENST00000380152', 'cdna', 0, 0, ctx);
      expect(bare).not.toHaveProperty('molecule');
    });
  });

  describe('getSequenceByRegion (issue #14)', () => {
    it('builds a /sequence/region/ URL and honors expand params', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'chromosome:GRCh38:13', seq: 'ACGTACGT' }),
      );
      const ctx = createMockContext();
      await getEnsemblService().getSequenceByRegion(
        'homo_sapiens',
        '13:32315086-32315100',
        10,
        10,
        ctx,
      );

      // The colon in the region is percent-encoded on the wire; decode to assert the path shape.
      const url = decodeURIComponent(mockFetch.mock.calls[0]?.[0] as string);
      expect(url).toContain('/sequence/region/homo_sapiens/13:32315086-32315100');
      expect(url).toContain('expand_5prime=10');
      expect(url).toContain('expand_3prime=10');
    });
  });

  describe('error envelope classification (issue #34)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Runs a call to settlement, advancing the fake clock through every retry backoff. */
    async function settle<T>(promise: Promise<T>) {
      const tracked = track(promise);
      await vi.runAllTimersAsync();
      await tracked.done;
      return tracked.state;
    }

    const lookup = () =>
      getEnsemblService().lookupGeneById('ENSG00000139618', false, createMockContext());

    it.each(OUTAGE_ENVELOPES)(
      'maps a database-outage envelope to a retried ServiceUnavailable that omits the upstream text: %#',
      async (error) => {
        mockFetch.mockResolvedValue(jsonResponse({ error }, 400));
        const { error: thrown } = await settle(lookup());

        expect(thrown).toBeInstanceOf(McpError);
        const mcpError = thrown as McpError;
        expect(mcpError.code).toBe(-32000);
        expect(mcpError.message).toBe(
          'Ensembl is temporarily unavailable: its REST server lost its database connection. (failed after 4 attempts)',
        );
        expect(mcpError.data).toMatchObject({
          status: 400,
          retryAttempts: 4,
          recovery: { hint: expect.stringContaining('Retry the call') },
        });
        expect(mockFetch).toHaveBeenCalledTimes(4);
        const surface = JSON.stringify({ message: mcpError.message, data: mcpError.data });
        for (const leak of ['mysql', 'MySQL', 'DBI', 'homo_sapiens_core', '/nfs/', 'anonymous']) {
          expect(surface).not.toContain(leak);
        }
      },
    );

    it('succeeds when a retry after a database outage gets an answer', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: OUTAGE_ENVELOPES[0] }, 400))
        .mockResolvedValueOnce(jsonResponse({ id: 'ENSG00000139618', display_name: 'BRCA2' }));
      const { value, error } = await settle(lookup());
      expect(error).toBeUndefined();
      expect(value).toMatchObject({ id: 'ENSG00000139618', displayName: 'BRCA2' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        'an unrecognized 400 envelope',
        400,
        'request for consequence of [A] matches reference [A]',
        -32007,
      ],
      ['an unrecognized 200 envelope', 200, 'Something unexpected happened', -32007],
      ['an unrecognized 404 envelope', 404, 'Something unexpected happened', -32001],
      ['a not-found message on a 400', 400, "ID 'ENSG99999999999' not found", -32001],
      ['a not-found message on a 500', 500, "ID 'ENSG99999999999' not found", -32001],
      ['an invalid message on a 500', 500, 'Invalid requested region 13:abc', -32007],
    ])('keeps Ensembl’s message, unretried, for %s', async (_label, status, error, code) => {
      mockFetch.mockResolvedValue(jsonResponse({ error }, status));
      const { error: thrown } = await settle(lookup());
      expect(thrown).toBeInstanceOf(McpError);
      expect(thrown).toMatchObject({ code, message: error });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('maps an unrecognized 5xx envelope to a retried ServiceUnavailable', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Something went wrong upstream' }, 500));
      const { error: thrown } = await settle(lookup());
      expect(thrown).toMatchObject({
        code: -32000,
        message: 'Ensembl API returned HTTP 500. (failed after 4 attempts)',
        data: { status: 500, retryAttempts: 4 },
      });
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it.each(TOOL_CALLS)(
      '%s reports an outage as a reasonless ServiceUnavailable with the retry hint',
      async (_label, def, args) => {
        mockFetch.mockResolvedValue(jsonResponse({ error: OUTAGE_ENVELOPES[1] }, 400));
        const { value: result } = await settle(runTool(def, args));
        const error = errorOf(result!);
        expect(error.code).toBe(-32000);
        expect(error.data?.reason).toBeUndefined();
        expect(error.data).toMatchObject({
          recovery: { hint: expect.stringContaining('Ensembl outage') },
        });
        const text = JSON.stringify(result);
        expect(text).not.toContain('DBI');
        expect(text).not.toContain('DBConnection');
      },
    );

    /** An uncaught Perl die inside Ensembl, as its REST server returns it (ensembl-rest#610). */
    const PERL_CRASH =
      'Can\'t call method "close" on unblessed reference at /nfs/public/ro/ensweb/live/rest/' +
      'www_110/ensembl-io/modules/Bio/EnsEMBL/IO/TabixParser.pm line 121.\n';

    it('maps an envelope carrying a Perl source location to a retried ServiceUnavailable without it', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: PERL_CRASH }, 400));
      const { error: thrown } = await settle(lookup());
      expect(thrown).toMatchObject({ code: -32000, data: { status: 400, retryAttempts: 4 } });
      expect(mockFetch).toHaveBeenCalledTimes(4);
      const surface = JSON.stringify({
        message: (thrown as McpError).message,
        data: (thrown as McpError).data,
      });
      for (const leak of ['/nfs/', '.pm line', 'TabixParser', 'unblessed']) {
        expect(surface).not.toContain(leak);
      }
    });

    it.each(TOOL_CALLS)(
      '%s reports an Ensembl-internal crash without a reason or its source path',
      async (_label, def, args) => {
        mockFetch.mockResolvedValue(jsonResponse({ error: PERL_CRASH }, 400));
        const { value: result } = await settle(runTool(def, args));
        const error = errorOf(result!);
        expect(error.code).toBe(-32000);
        expect(error.data?.reason).toBeUndefined();
        const text = JSON.stringify(result);
        expect(text).not.toContain('/nfs/');
        expect(text).not.toContain('TabixParser');
      },
    );

    it.each(TOOL_CALLS)(
      '%s reports a body that is not JSON as a reasonless ServiceUnavailable, never an input error',
      async (_label, def, args) => {
        mockFetch.mockResolvedValue({
          status: 200,
          ok: true,
          headers: { get: () => null },
          text: async () => '{"id":"ENSG0000013',
        } as unknown as Response);
        const { value: result } = await settle(runTool(def, args));
        const error = errorOf(result!);
        expect(error.code).toBe(-32000);
        expect(error.data?.reason).toBeUndefined();
      },
    );

    it('classifies a long adversarial envelope in linear time', async () => {
      // A near-miss of every pattern the envelope is tested against, none of them matching.
      const unit = 'could not connect to databas DBI connec not foun invali at /nfs/x lin ';
      const cpuMicros = async (size: number) => {
        const error = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        mockFetch.mockResolvedValueOnce(jsonResponse({ error }, 400));
        const start = process.threadCpuUsage();
        const { error: thrown } = await settle(lookup());
        const used = process.threadCpuUsage(start);
        expect(thrown).toMatchObject({ code: -32007 });
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

  describe('per-attempt timeout and call deadline (issue #38)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const lookup = (ctx = createMockContext()) =>
      getEnsemblService().lookupGeneById('ENSG00000139618', false, ctx);

    /** The upper bound of withRetry's first backoff: 1000 ms base with 25% jitter. */
    const FIRST_BACKOFF_MAX = 1_250;

    it('pins the measured bounds', () => {
      expect(ENSEMBL_ATTEMPT_TIMEOUT_MS).toBe(180_000);
      expect(ENSEMBL_CALL_DEADLINE_MS).toBe(240_000);
    });

    it.each([
      ['never sends headers', stalledFetch],
      ['sends headers, then stalls the body', stalledBodyFetch],
    ])(
      'bounds an upstream that %s: retried at the attempt timeout, failed at the deadline',
      async (_label, stall) => {
        mockFetch.mockImplementation(stall);
        const { state, done } = track(lookup());

        await vi.advanceTimersByTimeAsync(ENSEMBL_ATTEMPT_TIMEOUT_MS - 1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const firstSignal = (mockFetch.mock.calls[0]![1] as RequestInit).signal!;
        expect(firstSignal.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(firstSignal.aborted).toBe(true);
        expect((firstSignal.reason as DOMException).name).toBe('TimeoutError');

        await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(state.settledAt).toBeUndefined();

        const elapsed = ENSEMBL_ATTEMPT_TIMEOUT_MS + FIRST_BACKOFF_MAX;
        await vi.advanceTimersByTimeAsync(ENSEMBL_CALL_DEADLINE_MS - elapsed - 1);
        expect(state.settledAt).toBeUndefined();

        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(state.settledAt).toBe(ENSEMBL_CALL_DEADLINE_MS);
        expect(state.error).toBeInstanceOf(McpError);
        expect(state.error).toMatchObject({
          code: -32004,
          data: {
            reason: 'retry_deadline_exceeded',
            deadlineMs: ENSEMBL_CALL_DEADLINE_MS,
            retryAttempts: 2,
          },
        });
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('surfaces the attempt Timeout when it ends the last attempt before the deadline', async () => {
      // Three fast failures spend ~7 s of backoff; the fourth attempt stalls until its own timer.
      mockFetch
        .mockResolvedValueOnce(htmlPage())
        .mockResolvedValueOnce(htmlPage())
        .mockResolvedValueOnce(htmlPage())
        .mockImplementationOnce(stalledFetch);
      const { state, done } = track(lookup());
      await vi.runAllTimersAsync();
      await done;

      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(state.error).toMatchObject({
        code: -32004,
        message: 'Ensembl did not respond within 180s. (failed after 4 attempts)',
        data: { timeoutMs: ENSEMBL_ATTEMPT_TIMEOUT_MS, retryAttempts: 4 },
      });
      expect(state.settledAt).toBeLessThan(ENSEMBL_CALL_DEADLINE_MS);
      expect(state.settledAt).toBeGreaterThanOrEqual(ENSEMBL_ATTEMPT_TIMEOUT_MS);
    });

    it('returns the retry’s answer after an attempt times out', async () => {
      mockFetch
        .mockImplementationOnce(stalledBodyFetch)
        .mockResolvedValueOnce(jsonResponse({ id: 'ENSG00000139618', display_name: 'BRCA2' }));
      const { state, done } = track(lookup());
      await vi.advanceTimersByTimeAsync(ENSEMBL_ATTEMPT_TIMEOUT_MS + FIRST_BACKOFF_MAX);
      await done;
      expect(state.error).toBeUndefined();
      expect(state.value).toMatchObject({ displayName: 'BRCA2' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('leaves a normal response unaffected and no timer armed', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'ENSG00000139618', display_name: 'BRCA2' }),
      );
      const { state, done } = track(lookup());
      await vi.advanceTimersByTimeAsync(0);
      await done;
      expect(state.value).toMatchObject({ displayName: 'BRCA2' });
      expect(state.settledAt).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ends at once, unretried and not as a timeout, when the caller cancels mid-request', async () => {
      mockFetch.mockImplementation(stalledFetch);
      const caller = new AbortController();
      const { state, done } = track(lookup(createMockContext({ signal: caller.signal })));

      await vi.advanceTimersByTimeAsync(5_000);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;

      expect(state.settledAt).toBe(5_000);
      expect(state.error).toBe(caller.signal.reason);
      expect((state.error as DOMException).name).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(ENSEMBL_CALL_DEADLINE_MS);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ends at once, unretried, when the caller cancels mid-backoff', async () => {
      mockFetch.mockResolvedValue(htmlPage());
      const caller = new AbortController();
      const { state, done } = track(lookup(createMockContext({ signal: caller.signal })));

      await vi.advanceTimersByTimeAsync(500); // inside the first 750-1250 ms backoff
      expect(mockFetch).toHaveBeenCalledTimes(1);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;

      expect(state.settledAt).toBe(500);
      expect(state.error).toBe(caller.signal.reason);
      await vi.advanceTimersByTimeAsync(ENSEMBL_CALL_DEADLINE_MS);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('reports a cancelled tool call as RequestCancelled, not Timeout', async () => {
      mockFetch.mockImplementation(stalledFetch);
      const caller = new AbortController();
      const { state, done } = track(
        runToolContract(
          ensemblLookupGene,
          { id: 'ENSG00000139618' },
          { context: { signal: caller.signal } },
        ),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
      expect(state.settledAt).toBe(5_000);
      expect(errorOf(state.value!).code).toBe(-32011);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each(TOOL_CALLS)(
      '%s reports a stalled upstream as the deadline Timeout, never an input reason',
      async (_label, def, args) => {
        mockFetch.mockImplementation(stalledFetch);
        const { state, done } = track(runTool(def, args));
        await vi.advanceTimersByTimeAsync(ENSEMBL_CALL_DEADLINE_MS);
        await done;
        expect(state.settledAt).toBe(ENSEMBL_CALL_DEADLINE_MS);
        const error = errorOf(state.value!);
        expect(error.code).toBe(-32004);
        expect(error.data?.reason).toBe('retry_deadline_exceeded');
        expect(error.message).toContain('Ensembl request exceeded its 240000ms retry deadline');
      },
    );

    /** Answers after `ms` of fake time, or rejects as a real fetch does once its signal aborts. */
    const answerAfter = (ms: number, body: unknown) => (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(jsonResponse(body)), ms);
        init.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal!.reason);
          },
          { once: true },
        );
      });

    it('bounds a tool call by one deadline across all of its upstream requests', async () => {
      // A symbol that misses, then an xref, then the candidate lookup: three requests, each
      // well inside the attempt timeout, that together outlast the call deadline.
      mockFetch
        .mockImplementationOnce(
          answerAfter(100_000, { error: 'No valid lookup found for symbol HER2' }),
        )
        .mockImplementationOnce(answerAfter(100_000, [{ id: 'ENSG00000141736', type: 'gene' }]))
        .mockImplementationOnce(
          answerAfter(100_000, {
            ENSG00000141736: { id: 'ENSG00000141736', display_name: 'ERBB2' },
          }),
        );
      const { state, done } = track(runTool(ensemblLookupGene, { symbol: 'HER2' }));
      await vi.advanceTimersByTimeAsync(ENSEMBL_CALL_DEADLINE_MS);
      await done;

      expect(state.settledAt).toBe(ENSEMBL_CALL_DEADLINE_MS);
      const error = errorOf(state.value!);
      expect(error.code).toBe(-32004);
      expect(error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        deadlineMs: ENSEMBL_CALL_DEADLINE_MS,
      });
      expect(error.message).toContain('Ensembl request exceeded its 240000ms retry deadline');
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reports an unreachable upstream without its host name', async () => {
      mockFetch.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND ensembl-mirror.internal.example'), {
          code: 'ENOTFOUND',
        }),
      );
      const { state, done } = track(lookup());
      await vi.runAllTimersAsync();
      await done;
      expect(state.error).toMatchObject({ code: -32000, data: { retryAttempts: 4 } });
      expect(mockFetch).toHaveBeenCalledTimes(4);
      const surface = JSON.stringify({
        message: (state.error as McpError).message,
        data: (state.error as McpError).data,
      });
      expect(surface).not.toContain('ensembl-mirror.internal.example');
    });
  });

  describe('alias resolution (issue #20)', () => {
    const assemblyInfo = (...regions: string[]) => ({
      default_coord_system_version: 'GRCh38',
      top_level_region: regions.map((name) => ({ name, coord_system: 'chromosome' })),
    });
    const rawGene = (id: string, seq_region_name: string) => ({
      id,
      display_name: id,
      seq_region_name,
    });

    /** Route by path; each xref symbol maps to the IDs given. */
    function routeEnsembl(xrefs: Record<string, string[]>, regions: Record<string, string>) {
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.startsWith('/xrefs/symbol/')) {
          const symbol = decodeURIComponent(path.split('/')[4]!);
          return jsonResponse((xrefs[symbol] ?? []).map((id) => ({ id, type: 'gene' })));
        }
        if (path === '/lookup/id') {
          const { ids } = JSON.parse(init!.body as string) as { ids: string[] };
          return jsonResponse(
            Object.fromEntries(
              ids.map((id) => [id, regions[id] ? rawGene(id, regions[id]) : null]),
            ),
          );
        }
        if (path.startsWith('/info/assembly/')) return jsonResponse(assemblyInfo('1', '7', '8'));
        throw new Error(`Unmocked fetch: ${url}`);
      });
    }

    const paths = () => mockFetch.mock.calls.map((c) => new URL(c[0] as string).pathname);

    it('builds the gene-only xref URL and drops LRG and duplicate IDs', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { id: 'ENSG00000141736', type: 'gene' },
          { id: 'LRG_724', type: 'gene' },
          { id: 'ENSG00000141736', type: 'gene' },
        ]),
      );
      const ids = await getEnsemblService().getGeneIdsBySymbol(
        'HER2/neu',
        'homo_sapiens',
        createMockContext(),
      );
      expect(ids).toEqual(['ENSG00000141736']);
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        'https://rest.ensembl.org/xrefs/symbol/homo_sapiens/HER2%2Fneu?object_type=gene',
      );
    });

    it('returns gene IDs in a stable order whatever order Ensembl lists them in', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          { type: 'gene', id: 'ENSG00000109436' },
          { id: 'ENSG00000085563', type: 'gene' },
        ]),
      );
      const ids = await getEnsemblService().getGeneIdsBySymbol(
        'MDR1',
        'homo_sapiens',
        createMockContext(),
      );
      expect(ids).toEqual(['ENSG00000085563', 'ENSG00000109436']);
    });

    it('does not cache an assembly answer that lists no reference regions', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ default_coord_system_version: 'GRCh38' }))
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('1', '8')));
      const service = getEnsemblService();
      const ctx = createMockContext();
      expect([...(await service.getReferenceRegions('homo_sapiens', ctx))]).toEqual([]);
      expect([...(await service.getReferenceRegions('homo_sapiens', ctx))]).toEqual(['1', '8']);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('caches reference regions per species and never caches a failure', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: 'Something went wrong upstream' }))
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('1', '2', 'X')))
        .mockResolvedValueOnce(jsonResponse(assemblyInfo('I', 'II')));
      const service = getEnsemblService();
      const ctx = createMockContext();
      await expect(service.getReferenceRegions('homo_sapiens', ctx)).rejects.toThrow();
      expect([...(await service.getReferenceRegions('homo_sapiens', ctx))]).toEqual([
        '1',
        '2',
        'X',
      ]);
      await service.getReferenceRegions('homo_sapiens', ctx);
      expect([...(await service.getReferenceRegions('caenorhabditis_elegans', ctx))]).toEqual([
        'I',
        'II',
      ]);
      expect(paths()).toEqual([
        '/info/assembly/homo_sapiens',
        '/info/assembly/homo_sapiens',
        '/info/assembly/caenorhabditis_elegans',
      ]);
    });

    it('sends no candidate lookup when no symbol has an xref gene', async () => {
      routeEnsembl({}, {});
      const result = await getEnsemblService().resolveSymbolAliases(
        ['NOPE_A', 'NOPE_B'],
        'homo_sapiens',
        false,
        createMockContext(),
      );
      expect([...result.values()]).toEqual([{ kind: 'none' }, { kind: 'none' }]);
      expect(paths().filter((p) => p === '/lookup/id')).toHaveLength(0);
    });

    it('resolves several symbols with one candidate lookup and one assembly fetch', async () => {
      routeEnsembl(
        {
          GPR172A: ['ENSG00000185803', 'ENSG00000285112'],
          MDR1: ['ENSG00000085563', 'ENSG00000109436'],
          // Two names for one gene: the shared ID is sent once.
          PAR1: ['ENSG00000185803'],
          GONE: ['ENSG00000000404'],
        },
        {
          ENSG00000185803: '8',
          ENSG00000285112: 'HG2419_PATCH',
          ENSG00000085563: '7',
          ENSG00000109436: '1',
        },
      );
      const result = await getEnsemblService().resolveSymbolAliases(
        ['GPR172A', 'MDR1', 'PAR1', 'GONE'],
        'homo_sapiens',
        false,
        createMockContext(),
      );
      expect(result.get('GPR172A')).toMatchObject({
        kind: 'gene',
        gene: { id: 'ENSG00000185803' },
      });
      expect(result.get('MDR1')).toMatchObject({
        kind: 'ambiguous',
        candidates: [{ id: 'ENSG00000085563' }, { id: 'ENSG00000109436' }],
      });
      expect(result.get('PAR1')).toMatchObject({ kind: 'gene', gene: { id: 'ENSG00000185803' } });
      // An xref ID /lookup/id answers null for (retired or not a gene) resolves to nothing.
      expect(result.get('GONE')).toEqual({ kind: 'none' });

      const lookupCalls = mockFetch.mock.calls.filter(
        (c) => new URL(c[0] as string).pathname === '/lookup/id',
      );
      expect(lookupCalls).toHaveLength(1);
      const { ids } = JSON.parse((lookupCalls[0]![1] as RequestInit).body as string) as {
        ids: string[];
      };
      expect(ids.sort()).toEqual(
        [
          'ENSG00000000404',
          'ENSG00000085563',
          'ENSG00000109436',
          'ENSG00000185803',
          'ENSG00000285112',
        ].sort(),
      );
      expect(paths().filter((p) => p.startsWith('/info/assembly/'))).toHaveLength(1);
    });

    it('keeps every candidate when the reference regions cannot be read', async () => {
      routeEnsembl(
        {
          GPR172A: ['ENSG00000185803', 'ENSG00000285112'],
          MDR1: ['ENSG00000085563', 'ENSG00000109436'],
        },
        {
          ENSG00000185803: '8',
          ENSG00000285112: 'HG2419_PATCH',
          ENSG00000085563: '7',
          ENSG00000109436: '1',
        },
      );
      const routed = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
        new URL(url).pathname.startsWith('/info/assembly/') ? htmlPage() : routed(url, init),
      );
      vi.useFakeTimers();
      try {
        const pending = getEnsemblService().resolveSymbolAliases(
          ['GPR172A', 'MDR1'],
          'homo_sapiens',
          false,
          createMockContext(),
        );
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.get('GPR172A')).toMatchObject({
          kind: 'ambiguous',
          candidates: [{ id: 'ENSG00000185803' }, { id: 'ENSG00000285112' }],
        });
        expect(result.get('MDR1')).toMatchObject({
          kind: 'ambiguous',
          candidates: [{ id: 'ENSG00000085563' }, { id: 'ENSG00000109436' }],
        });
        // One read for the call, retried as any request is, not one per symbol.
        const assemblyReads = paths().filter((p) => p.startsWith('/info/assembly/'));
        expect(new Set(assemblyReads)).toEqual(new Set(['/info/assembly/homo_sapiens']));
        expect(assemblyReads.length).toBeLessThanOrEqual(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('stable-ID version suffix (issue #41)', () => {
    const gene = { id: 'ENSG00000139618', display_name: 'BRCA2', seq_region_name: '13' };
    const urls = () => mockFetch.mock.calls.map((c) => c[0] as string);

    /** Every service method that sends a caller's stable ID upstream, with the URL it builds. */
    const SITES = [
      [
        'lookupGeneById',
        (id: string) => getEnsemblService().lookupGeneById(id, false, createMockContext()),
        gene,
        (id: string) => `https://rest.ensembl.org/lookup/id/${id}`,
      ],
      [
        'lookupTranscript',
        (id: string) => getEnsemblService().lookupTranscript(id, createMockContext()),
        { id: 'ENST00000380152', Parent: 'ENSG00000139618' },
        (id: string) => `https://rest.ensembl.org/lookup/id/${id}`,
      ],
      [
        'getSequenceById',
        (id: string) => getEnsemblService().getSequenceById(id, 'cdna', 0, 0, createMockContext()),
        { id: 'ENST00000380152', seq: 'ACGT', molecule: 'dna' },
        (id: string) => `https://rest.ensembl.org/sequence/id/${id}?type=cdna`,
      ],
      [
        'getXrefsById',
        (id: string) => getEnsemblService().getXrefsById(id, undefined, createMockContext()),
        [],
        (id: string) => `https://rest.ensembl.org/xrefs/id/${id}`,
      ],
      [
        'getHomologyById',
        (id: string) =>
          getEnsemblService().getHomologyById(
            id,
            'homo_sapiens',
            'orthologues',
            undefined,
            createMockContext(),
          ),
        { data: [{ id: 'ENSG00000139618', homologies: [] }] },
        (id: string) => `https://rest.ensembl.org/homology/id/homo_sapiens/${id}?type=orthologues`,
      ],
    ] as const;

    it.each(SITES)(
      '%s drops the version from an Ensembl stable ID',
      async (_m, call, body, url) => {
        for (const id of ['ENSG00000139618.19', 'ensg00000139618.2']) {
          mockFetch.mockResolvedValueOnce(jsonResponse(body));
          await call(id);
        }
        expect(urls()).toEqual([url('ENSG00000139618'), url('ensg00000139618')]);
      },
    );

    it.each(SITES)('%s forwards other IDs unchanged', async (_m, call, body, url) => {
      // Non-ENS (where .1 is part of the ID), unversioned, a short number, a bare dot.
      const ids = ['AT3G52430.1', 'ENSG00000139618', 'ENSG0013961.17', 'ENSG00000139618.'];
      for (const id of ids) {
        mockFetch.mockResolvedValueOnce(jsonResponse(body));
        await call(id);
      }
      expect(urls()).toEqual(ids.map((id) => url(encodeURIComponent(id))));
    });

    it('lookupGenesBatch sends each stable ID once, unversioned, keyed back by the submitted ID', async () => {
      mockFetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const { ids } = JSON.parse(init!.body as string) as { ids: string[] };
        // Ensembl keys the answer by the ID as sent, and answers a versioned one null.
        return jsonResponse(
          Object.fromEntries(ids.map((id) => [id, id === 'ENSG00000139618' ? gene : null])),
        );
      });
      const result = await getEnsemblService().lookupGenesBatch(
        ['ENSG00000139618.19', 'ENSG00000139618', 'ENSG00000139618.3', 'AT3G52430.1'],
        false,
        createMockContext(),
      );
      const { ids } = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
        ids: string[];
      };
      expect(ids).toEqual(['ENSG00000139618', 'AT3G52430.1']);
      expect([...result.keys()]).toEqual([
        'ENSG00000139618.19',
        'ENSG00000139618',
        'ENSG00000139618.3',
      ]);
      expect(result.get('ENSG00000139618.3')).toMatchObject({ id: 'ENSG00000139618' });
    });
  });

  describe('mitochondrion alias check (issue #39)', () => {
    /** What /info/assembly/{species}/{name}?synonyms=1 answers, mirroring rest.ensembl.org. */
    const RESOLVED: Record<string, { status?: number; body: unknown }> = {
      // An unrelated patch scaffold; which one varies between calls, never the mitochondrion.
      'homo_sapiens/chrM': {
        body: {
          coordinate_system: 'scaffold',
          length: 140567,
          synonyms: [
            { dbname: 'INSDC', name: 'MU273394.1' },
            { dbname: 'UCSC', name: 'chrX_MU273394v1_fix' },
          ],
        },
      },
      'homo_sapiens/CHRM': {
        body: {
          coordinate_system: 'chromosome',
          length: 16569,
          synonyms: [
            { dbname: 'UCSC', name: 'chrM' },
            { dbname: 'RefSeq_genomic', name: 'NC_012920.1' },
          ],
        },
      },
      'drosophila_melanogaster/M': {
        body: {
          coordinate_system: 'primary_assembly',
          length: 19524,
          synonyms: [
            { dbname: 'INSDC_submitted_name', name: 'mitochondrion_genome' },
            { dbname: 'GenBank', name: 'chrM' },
          ],
        },
      },
      'apis_mellifera/M': {
        body: {
          coordinate_system: 'primary_assembly',
          length: 16343,
          synonyms: [
            { dbname: 'GenBank', name: 'MT' },
            { dbname: 'INSDC', name: 'CM009947.2' },
          ],
        },
      },
      'caenorhabditis_elegans/chrM': {
        body: {
          coordinate_system: 'contig',
          length: 36355,
          synonyms: [{ dbname: 'wormbase_id', name: 'M01F1' }],
        },
      },
      'plasmodium_falciparum/chrM': {
        body: { synonyms: [{ dbname: 'BRC4_Community_Symbol', name: 'MAL1' }] },
      },
      'danio_rerio/chrM': { status: 400, body: { error: 'No slice found for location chrM' } },
      'not_a_species/chrM': {
        status: 400,
        body: { error: "Can not find internal name for species 'not_a_species'" },
      },
    };
    const TOP_LEVEL: Record<string, string[]> = {
      homo_sapiens: ['1', '13', 'X', 'MT', 'KI270757.1'],
      caenorhabditis_elegans: ['I', 'II', 'X', 'MtDNA'],
      danio_rerio: ['1', 'MT'],
      plasmodium_falciparum: ['Pf3D7_01_v3', 'Pf3D7_MIT_v3'],
    };

    beforeEach(() => {
      mockFetch.mockImplementation(async (url: string) => {
        const { pathname, search } = new URL(url);
        const [, , , species = '', name] = pathname.split('/').map(decodeURIComponent);
        const answer = name === undefined ? undefined : RESOLVED[`${species}/${name}`];
        if (answer && search === '?synonyms=1') return jsonResponse(answer.body, answer.status);
        if (name === undefined && TOP_LEVEL[species]) {
          return jsonResponse({
            default_coord_system_version: 'X',
            top_level_region: TOP_LEVEL[species].map((n) => ({ name: n, coord_system: 'c' })),
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      });
    });

    const paths = () =>
      mockFetch.mock.calls.map((c) => {
        const { pathname, search } = new URL(c[0] as string);
        return pathname + search;
      });

    it.each([
      ['drosophila_melanogaster', 'M'],
      ['apis_mellifera', 'M'],
      ['homo_sapiens', 'CHRM'],
    ])('passes %s %s, which Ensembl resolves to the mitochondrion', async (species, name) => {
      const check = await getEnsemblService().checkMitochondrionAlias(
        species,
        name,
        createMockContext(),
      );
      expect(check).toEqual({ resolves: true });
      expect(paths()).toEqual([`/info/assembly/${species}/${name}?synonyms=1`]);
    });

    it.each([
      ['homo_sapiens', 'chrM', 'MT'],
      ['caenorhabditis_elegans', 'chrM', 'MtDNA'],
      ['danio_rerio', 'chrM', 'MT'],
    ])('fails %s %s and names the mitochondrion %s', async (species, name, mitochondrion) => {
      const check = await getEnsemblService().checkMitochondrionAlias(
        species,
        name,
        createMockContext(),
      );
      expect(check).toEqual({ resolves: false, mitochondrion });
      expect(paths()).toEqual([
        `/info/assembly/${species}/${name}?synonyms=1`,
        `/info/assembly/${species}`,
      ]);
    });

    it('omits the name when no reference region is recognizably the mitochondrion', async () => {
      const check = await getEnsemblService().checkMitochondrionAlias(
        'plasmodium_falciparum',
        'chrM',
        createMockContext(),
      );
      expect(check).toEqual({ resolves: false });
    });

    it('keeps each verdict for the process, keyed by species and spelling', async () => {
      const service = getEnsemblService();
      for (let i = 0; i < 3; i++) {
        await service.checkMitochondrionAlias('homo_sapiens', 'chrM', createMockContext());
        await service.checkMitochondrionAlias('homo_sapiens', 'CHRM', createMockContext());
      }
      expect(paths()).toEqual([
        '/info/assembly/homo_sapiens/chrM?synonyms=1',
        '/info/assembly/homo_sapiens',
        '/info/assembly/homo_sapiens/CHRM?synonyms=1',
      ]);
    });

    it('fails without a name when the reference regions cannot be read', async () => {
      mockFetch.mockImplementation(async (url: string) =>
        url.endsWith('?synonyms=1')
          ? jsonResponse(RESOLVED['homo_sapiens/chrM']!.body)
          : htmlPage(),
      );
      vi.useFakeTimers();
      try {
        const pending = getEnsemblService().checkMitochondrionAlias(
          'homo_sapiens',
          'chrM',
          createMockContext(),
        );
        await vi.runAllTimersAsync();
        expect(await pending).toEqual({ resolves: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces an unrecognized species with Ensembl’s message unchanged', async () => {
      await expect(
        getEnsemblService().checkMitochondrionAlias('not_a_species', 'chrM', createMockContext()),
      ).rejects.toThrow("Can not find internal name for species 'not_a_species'");
    });
  });
});
