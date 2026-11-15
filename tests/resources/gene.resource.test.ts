/**
 * @fileoverview Tests for the ensembl://gene/{id} resource.
 * @module tests/resources/gene.resource.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGeneResource } from '@/mcp-server/resources/definitions/gene.resource.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { GeneRecord } from '@/services/ensembl/types.js';

const mockLookupGeneOnly = vi.fn();

/** When `real` is set, the resource runs against the real EnsemblService over a fetch fake. */
const upstream = vi.hoisted(() => ({ real: false }));

vi.mock('@/services/ensembl/ensembl-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ensembl/ensembl-service.js')>();
  return {
    ...actual,
    getEnsemblService: () =>
      upstream.real ? actual.getEnsemblService() : { lookupGeneOnly: mockLookupGeneOnly },
  };
});

const brca2: GeneRecord = {
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
  transcripts: [
    {
      id: 'ENST00000380152',
      displayName: 'BRCA2-201',
      biotype: 'protein_coding',
      isCanonical: true,
      start: 32315086,
      end: 32400268,
      strand: 1,
    },
  ],
};

/** Ensembl's refusal of `?expand=1` for a Translation or Exon, sent before any record. */
const EXPAND_REFUSAL = { error: 'Expand option only available for Genes and Transcripts' };

/** `/lookup/id` records as rest.ensembl.org answers them, trimmed, keyed by the requested ID. */
const LOOKUP_ID = new Map<string, Record<string, unknown>>([
  [
    'ENSG00000139618',
    {
      id: 'ENSG00000139618',
      object_type: 'Gene',
      display_name: 'BRCA2',
      Transcript: [{ id: 'ENST00000380152', object_type: 'Transcript', is_canonical: 1 }],
    },
  ],
  [
    'ENSG00000244734',
    {
      id: 'ENSG00000244734',
      object_type: 'Gene',
      display_name: 'HBB',
      canonical_transcript: 'ENST00000335295.4',
      species: 'homo_sapiens',
      seq_region_name: '11',
      start: 5225464,
      end: 5229395,
      strand: -1,
      assembly_name: 'GRCh38',
      Transcript: [
        {
          id: 'ENST00000335295',
          object_type: 'Transcript',
          Parent: 'ENSG00000244734',
          display_name: 'HBB-201',
          is_canonical: 1,
          MANE: [{ type: 'MANE_Select', refseq_match: 'NM_000518.5' }],
        },
      ],
    },
  ],
  [
    'AT1G01010',
    {
      id: 'AT1G01010',
      object_type: 'Gene',
      display_name: 'NAC001',
      canonical_transcript: 'AT1G01010.1.',
      Transcript: [
        { id: 'AT1G01010.1', object_type: 'Transcript', Parent: 'AT1G01010', is_canonical: 1 },
      ],
    },
  ],
  // Also the ID of YFL039C_mRNA's translation; /lookup/id answers the Gene.
  [
    'YFL039C',
    {
      id: 'YFL039C',
      object_type: 'Gene',
      display_name: 'ACT1',
      canonical_transcript: 'YFL039C_mRNA.',
      Transcript: [
        { id: 'YFL039C_mRNA', object_type: 'Transcript', Parent: 'YFL039C', is_canonical: 1 },
      ],
    },
  ],
  [
    'LRG_1',
    {
      id: 'LRG_1',
      object_type: 'Gene',
      display_name: 'COL1A1',
      canonical_transcript: 'LRG_1t1.1',
      Transcript: [],
    },
  ],
  // An expanded Transcript answers 200: its Exon list and Translation, never a Transcript list.
  [
    'ENST00000335295',
    {
      id: 'ENST00000335295',
      object_type: 'Transcript',
      Parent: 'ENSG00000244734',
      display_name: 'HBB-201',
      is_canonical: 1,
      Exon: [{ id: 'ENSE00001829867', object_type: 'Exon' }],
      Translation: { id: 'ENSP00000333994', object_type: 'Translation' },
    },
  ],
  // Also the ID of its translation; /lookup/id answers the Transcript.
  [
    'AT1G01010.1',
    {
      id: 'AT1G01010.1',
      object_type: 'Transcript',
      Parent: 'AT1G01010',
      display_name: 'NAC001-201',
      is_canonical: 1,
    },
  ],
  [
    'ENSP00000333994',
    {
      id: 'ENSP00000333994',
      object_type: 'Translation',
      Parent: 'ENST00000335295',
      length: 147,
      start: 5225598,
      end: 5227021,
    },
  ],
  ['ENSE00001829867', { id: 'ENSE00001829867', object_type: 'Exon', start: 5226930, end: 5227071 }],
  // No such type is reachable on /lookup/id today; it stands in for one Ensembl adds.
  ['ENSR00000000001', { id: 'ENSR00000000001', object_type: 'RegulatoryFeature' }],
  // A record that names no type: nothing in it says it is not a gene.
  [
    'ENSG00000141510',
    {
      id: 'ENSG00000141510',
      display_name: 'TP53',
      Transcript: [{ id: 'ENST00000269305', is_canonical: 1 }],
    },
  ],
]);

/**
 * Reads `id` through the real service over a `/lookup/id` fake that answers like Ensembl:
 * the record, a refusal to expand a Translation or Exon, or not found. Records every request URL.
 */
async function readUpstream(
  id: string,
  respond?: (request: Request) => Response | Promise<Response> | undefined,
): Promise<{ value: unknown; error: unknown; urls: string[] }> {
  const http = createFetchMock([
    {
      match: /^https:\/\/rest\.ensembl\.org\/lookup\/id\//,
      respond: (request) => {
        const scripted = respond?.(request);
        if (scripted) return scripted;
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const record = LOOKUP_ID.get(key);
        if (!record) return Response.json({ error: `ID '${key}' not found` }, { status: 400 });
        const expanded = url.searchParams.get('expand') === '1';
        if (expanded && (record.object_type === 'Translation' || record.object_type === 'Exon')) {
          return Response.json(EXPAND_REFUSAL, { status: 400 });
        }
        return Response.json(record);
      },
    },
  ]);
  http.install();
  upstream.real = true;
  initEnsemblService({} as AppConfig, createInMemoryStorage());
  try {
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id });
    const settled = await Promise.resolve(ensemblGeneResource.handler(params, ctx)).then(
      (value: unknown) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    return { ...settled, urls: http.calls.map((c) => c.request.url) };
  } finally {
    upstream.real = false;
    http.restore();
  }
}

const expandedUrl = (id: string) => `https://rest.ensembl.org/lookup/id/${id}?expand=1&mane=1`;

describe('ensemblGeneResource', () => {
  it('returns gene record with all fields for a valid ID', async () => {
    mockLookupGeneOnly.mockResolvedValueOnce({ kind: 'gene', gene: brca2 });
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id: 'ENSG00000139618' });
    const result = await ensemblGeneResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'ENSG00000139618',
      displayName: 'BRCA2',
      chromosome: '13',
      assemblyName: 'GRCh38',
    });
  });

  it('requests expanded transcripts (expand=true)', async () => {
    const { value, urls } = await readUpstream('ENSG00000139618');
    // Resource always fetches with expanded transcripts
    expect(value).toMatchObject({ transcripts: [{ id: 'ENST00000380152', isCanonical: true }] });
    expect(urls).toEqual([expandedUrl('ENSG00000139618')]);
  });

  it('throws not_found when gene ID does not exist', async () => {
    mockLookupGeneOnly.mockRejectedValueOnce(notFound("ID 'ENSG99999999999' not found"));
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id: 'ENSG99999999999' });
    await expect(ensemblGeneResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('surfaces the declared recovery hint on a not_found error (issue #16)', async () => {
    mockLookupGeneOnly.mockRejectedValueOnce(notFound("ID 'ENSG99999999999' not found"));
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id: 'ENSG99999999999' });
    await expect(ensemblGeneResource.handler(params, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: {
          hint: ensemblGeneResource.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });

  it('lists example resources', async () => {
    const listing = await ensemblGeneResource.list!(
      {} as Parameters<NonNullable<typeof ensemblGeneResource.list>>[0],
    );
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri as string).toMatch(/^ensembl:\/\/gene\//);
    }
  });

  it('returns sparse gene record without crash', async () => {
    const sparseGene: GeneRecord = { id: 'ENSG00000000001' };
    mockLookupGeneOnly.mockResolvedValueOnce({ kind: 'gene', gene: sparseGene });
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id: 'ENSG00000000001' });
    const result = await ensemblGeneResource.handler(params, ctx);
    expect((result as GeneRecord).id).toBe('ENSG00000000001');
  });
});

describe('ensemblGeneResource versioned stable IDs (issue #41)', () => {
  it('reads a versioned ID as the current gene record', async () => {
    const http = createFetchMock([
      {
        match: /^https:\/\/rest\.ensembl\.org\/lookup\/id\//,
        // Like Ensembl, a versioned stable ID is not found, even for the current version.
        respond: (request) =>
          /\.\d+\?/.test(request.url)
            ? Response.json({ error: "ID 'ENSG00000139618.19' not found" }, { status: 400 })
            : Response.json({
                id: 'ENSG00000139618',
                object_type: 'Gene',
                display_name: 'BRCA2',
                version: 19,
              }),
      },
    ]);
    http.install();
    upstream.real = true;
    initEnsemblService({} as AppConfig, createInMemoryStorage());
    try {
      const ctx = createMockContext({ errors: ensemblGeneResource.errors });
      const params = ensemblGeneResource.params!.parse({ id: 'ENSG00000139618.19' });
      const result = await ensemblGeneResource.handler(params, ctx);
      expect(result).toMatchObject({ id: 'ENSG00000139618', displayName: 'BRCA2' });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        'https://rest.ensembl.org/lookup/id/ENSG00000139618?expand=1&mane=1',
      ]);
    } finally {
      upstream.real = false;
      http.restore();
    }
  });

  it('describes the version suffix as dropped', () => {
    expect(ensemblGeneResource.params!.shape.id.description).toContain('dropped');
  });
});

describe('ensemblGeneResource object type (issue #63)', () => {
  it.each([
    ['ENSG00000244734', 'ENST00000335295.4', 'ENST00000335295'],
    ['AT1G01010', 'AT1G01010.1', 'AT1G01010.1'],
    ['YFL039C', 'YFL039C_mRNA', 'YFL039C_mRNA'],
  ])('reads %s, a Gene record, in one request', async (id, canonicalTranscript, transcriptId) => {
    const { value, error, urls } = await readUpstream(id);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ id, canonicalTranscript, transcripts: [{ id: transcriptId }] });
    expect(value).not.toHaveProperty('parentGeneId');
    expect(urls).toEqual([expandedUrl(id)]);
  });

  it('reads an LRG gene, whose canonical transcript carries a version', async () => {
    const { value, urls } = await readUpstream('LRG_1');
    expect(value).toMatchObject({ id: 'LRG_1', canonicalTranscript: 'LRG_1t1.1' });
    expect(urls).toEqual([expandedUrl('LRG_1')]);
  });

  it.each([
    {
      id: 'ENST00000335295',
      objectType: 'Transcript',
      parentId: 'ENSG00000244734',
      message:
        'ENST00000335295 is not a gene: its Ensembl object_type is Transcript. Its parent is ENSG00000244734.',
      hint: 'Read its gene with ensembl://gene/ENSG00000244734, or the transcript with ensembl://transcript/ENST00000335295.',
      requests: 1,
    },
    {
      id: 'AT1G01010.1',
      objectType: 'Transcript',
      parentId: 'AT1G01010',
      message:
        'AT1G01010.1 is not a gene: its Ensembl object_type is Transcript. Its parent is AT1G01010.',
      hint: 'Read its gene with ensembl://gene/AT1G01010, or the transcript with ensembl://transcript/AT1G01010.1.',
      requests: 1,
    },
    {
      id: 'ENSP00000333994',
      objectType: 'Translation',
      parentId: 'ENST00000335295',
      message:
        'ENSP00000333994 is not a gene: its Ensembl object_type is Translation. Its parent is ENST00000335295.',
      hint: 'Read its transcript with ensembl://transcript/ENST00000335295, whose parentGeneId names the gene, or the protein with ensembl_get_sequence (id ENSP00000333994, type "protein").',
      requests: 2,
    },
    {
      id: 'ENSE00001829867',
      objectType: 'Exon',
      message: 'ENSE00001829867 is not a gene: its Ensembl object_type is Exon.',
      hint: "Read the exon's sequence with ensembl_get_sequence (id ENSE00001829867).",
      requests: 2,
    },
  ])('refuses $id (object_type $objectType) as wrong_object_type', async (row) => {
    const { value, error, urls } = await readUpstream(row.id);
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError, message: row.message });
    expect((error as { data: unknown }).data).toEqual({
      reason: 'wrong_object_type',
      objectType: row.objectType,
      ...(row.parentId && { parentId: row.parentId }),
      recovery: { hint: row.hint },
    });
    // A refused expansion costs one unexpanded request to learn the type; nothing else does.
    expect(urls).toEqual(
      [expandedUrl(row.id), `https://rest.ensembl.org/lookup/id/${row.id}`].slice(0, row.requests),
    );
  });

  it('leaves an object type it has no reader for to the declared recovery', async () => {
    const { error } = await readUpstream('ENSR00000000001');
    // No recovery at the throw site: the framework fills the contract's hint on the wire.
    expect((error as { data: unknown }).data).toEqual({
      reason: 'wrong_object_type',
      objectType: 'RegulatoryFeature',
    });
  });

  it('reads a record that names no object_type as the gene, as before', async () => {
    const { value, error, urls } = await readUpstream('ENSG00000141510');
    expect(error).toBeUndefined();
    expect(value).toEqual({
      id: 'ENSG00000141510',
      displayName: 'TP53',
      transcripts: [{ id: 'ENST00000269305', isCanonical: true }],
    });
    expect(urls).toEqual([expandedUrl('ENSG00000141510')]);
  });

  it('keeps the expand refusal when the unexpanded record names no object_type', async () => {
    const { error, urls } = await readUpstream('ENSP00000333994', (request) =>
      new URL(request.url).searchParams.has('expand')
        ? Response.json(EXPAND_REFUSAL, { status: 400 })
        : Response.json({ id: 'ENSP00000333994', Parent: 'ENST00000335295' }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: EXPAND_REFUSAL.error,
    });
    expect((error as { data?: { reason?: string } }).data?.reason).toBeUndefined();
    expect(urls).toEqual([
      expandedUrl('ENSP00000333994'),
      'https://rest.ensembl.org/lookup/id/ENSP00000333994',
    ]);
  });

  it('passes another refusal of the expanded request through, without a second request', async () => {
    const { error, urls } = await readUpstream('ENSG00000244734', () =>
      Response.json({ error: 'Cannot expand this record today' }, { status: 400 }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Cannot expand this record today',
    });
    expect((error as { data?: { reason?: string } }).data?.reason).toBeUndefined();
    expect(urls).toEqual([expandedUrl('ENSG00000244734')]);
  });

  it('maps an ID unknown to Ensembl to not_found after one request', async () => {
    const { error, urls } = await readUpstream('ENSG99999999999');
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(urls).toEqual([expandedUrl('ENSG99999999999')]);
  });

  it('declares wrong_object_type as a ValidationError', () => {
    expect(ensemblGeneResource.errors!.find((e) => e.reason === 'wrong_object_type')).toMatchObject(
      { code: JsonRpcErrorCode.ValidationError },
    );
  });
});

describe('ensemblGeneResource when the unexpanded type read fails (issue #63)', () => {
  const plainUrl = 'https://rest.ensembl.org/lookup/id/ENSP00000333994';

  /** Reads ENSP00000333994 with the expand refusal intact and `second` answering the unexpanded read; retries run on a fake clock. */
  async function readWithSecond(second: (request: Request) => Response | Promise<Response>) {
    vi.useFakeTimers();
    try {
      const pending = readUpstream('ENSP00000333994', (request) =>
        new URL(request.url).searchParams.has('expand') ? undefined : second(request),
      );
      await vi.runAllTimersAsync();
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it.each([
    {
      label: 'a not-found answer',
      second: () => Response.json({ error: "ID 'ENSP00000333994' not found" }, { status: 400 }),
      code: JsonRpcErrorCode.NotFound,
      reason: 'not_found',
      attempts: 1,
    },
    {
      label: 'a 404',
      second: () => Response.json({ error: 'Page not found' }, { status: 404 }),
      code: JsonRpcErrorCode.NotFound,
      reason: 'not_found',
      attempts: 1,
    },
    {
      label: 'another 400',
      second: () => Response.json({ error: 'Lookup refused' }, { status: 400 }),
      code: JsonRpcErrorCode.ValidationError,
      reason: undefined,
      attempts: 1,
    },
    {
      label: 'a 403',
      second: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
      code: JsonRpcErrorCode.ValidationError,
      reason: undefined,
      attempts: 1,
    },
    {
      label: 'a 429',
      second: () => new Response('', { status: 429, headers: { 'Retry-After': '1' } }),
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: undefined,
      attempts: 4,
    },
    {
      label: 'a 503',
      second: () => Response.json({ error: 'Service Unavailable' }, { status: 503 }),
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: undefined,
      attempts: 4,
    },
    {
      label: 'an HTML error page',
      second: () =>
        new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', { status: 502 }),
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: undefined,
      attempts: 4,
    },
  ])('surfaces $label on the type read as that read’s error, not the refusal', async (row) => {
    const { value, error, urls } = await readWithSecond(row.second);
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: row.code });
    expect((error as { data?: { reason?: string } }).data?.reason).toBe(row.reason);
    expect(urls).toEqual([expandedUrl('ENSP00000333994'), ...Array(row.attempts).fill(plainUrl)]);
  });

  it('times out a hung type read at the call deadline', async () => {
    const { error, urls } = await readWithSecond(
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 240_000 },
    });
    expect(urls[0]).toBe(expandedUrl('ENSP00000333994'));
    expect(urls.slice(1).every((url) => url === plainUrl)).toBe(true);
  });
});

describe('ensemblGeneResource classifies by error code, not message text (issue #63)', () => {
  it('maps a NotFound whose text never says "not found" to not_found', async () => {
    mockLookupGeneOnly.mockRejectedValueOnce(notFound('ENSG00000000000 does not exist'));
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id: 'ENSG00000000000' });
    await expect(ensemblGeneResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('passes another error through unchanged even when its text says "not found"', async () => {
    const outage = serviceUnavailable('Ensembl lookup backend not found; retry shortly.');
    mockLookupGeneOnly.mockRejectedValueOnce(outage);
    const ctx = createMockContext({ errors: ensemblGeneResource.errors });
    const params = ensemblGeneResource.params!.parse({ id: 'ENSG00000139618' });
    await expect(ensemblGeneResource.handler(params, ctx)).rejects.toBe(outage);
  });
});
