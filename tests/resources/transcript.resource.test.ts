/**
 * @fileoverview Tests for the ensembl://transcript/{id} resource.
 * @module tests/resources/transcript.resource.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblTranscriptResource } from '@/mcp-server/resources/definitions/transcript.resource.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { TranscriptRecord } from '@/services/ensembl/types.js';

const mockLookupTranscript = vi.fn();

/** When `real` is set, the resource runs against the real EnsemblService over a fetch fake. */
const upstream = vi.hoisted(() => ({ real: false }));

vi.mock('@/services/ensembl/ensembl-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ensembl/ensembl-service.js')>();
  return {
    ...actual,
    getEnsemblService: () =>
      upstream.real ? actual.getEnsemblService() : { lookupTranscript: mockLookupTranscript },
  };
});

const canonicalTranscript: TranscriptRecord = {
  id: 'ENST00000380152',
  parentGeneId: 'ENSG00000139618',
  displayName: 'BRCA2-201',
  biotype: 'protein_coding',
  isCanonical: true,
  species: 'homo_sapiens',
  chromosome: '13',
  start: 32315086,
  end: 32400268,
  strand: 1,
  assemblyName: 'GRCh38',
  lengthInBp: 10257,
};

describe('ensemblTranscriptResource', () => {
  it('returns transcript record for valid ID', async () => {
    mockLookupTranscript.mockResolvedValueOnce({
      kind: 'transcript',
      transcript: canonicalTranscript,
    });
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id: 'ENST00000380152' });
    const result = await ensemblTranscriptResource.handler(params, ctx);
    expect(result).toMatchObject({
      id: 'ENST00000380152',
      parentGeneId: 'ENSG00000139618',
      isCanonical: true,
      biotype: 'protein_coding',
    });
  });

  it('throws not_found when transcript ID does not exist', async () => {
    mockLookupTranscript.mockRejectedValueOnce(notFound("ID 'ENST99999999999' not found"));
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id: 'ENST99999999999' });
    await expect(ensemblTranscriptResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('surfaces the declared recovery hint on a not_found error (issue #16)', async () => {
    mockLookupTranscript.mockRejectedValueOnce(notFound("ID 'ENST99999999999' not found"));
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id: 'ENST99999999999' });
    await expect(ensemblTranscriptResource.handler(params, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: {
          hint: ensemblTranscriptResource.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });

  it('lists example resources', async () => {
    const listing = await ensemblTranscriptResource.list!(
      {} as Parameters<NonNullable<typeof ensemblTranscriptResource.list>>[0],
    );
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri as string).toMatch(/^ensembl:\/\/transcript\//);
    }
  });

  it('returns sparse transcript record without crash', async () => {
    const sparse: TranscriptRecord = { id: 'ENST00000000001', isCanonical: false };
    mockLookupTranscript.mockResolvedValueOnce({ kind: 'transcript', transcript: sparse });
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id: 'ENST00000000001' });
    const result = await ensemblTranscriptResource.handler(params, ctx);
    expect((result as TranscriptRecord).id).toBe('ENST00000000001');
    expect((result as TranscriptRecord).isCanonical).toBe(false);
  });
});

describe('ensemblTranscriptResource versioned stable IDs (issue #41)', () => {
  it('reads a versioned ID as the current transcript record', async () => {
    const http = createFetchMock([
      {
        match: /^https:\/\/rest\.ensembl\.org\/lookup\/id\//,
        // Like Ensembl, a versioned stable ID is not found, even for the current version.
        respond: (request) =>
          /\.\d+$/.test(request.url)
            ? Response.json({ error: "ID 'ENST00000380152.8' not found" }, { status: 400 })
            : Response.json({
                id: 'ENST00000380152',
                object_type: 'Transcript',
                Parent: 'ENSG00000139618',
                is_canonical: 1,
              }),
      },
    ]);
    http.install();
    upstream.real = true;
    initEnsemblService({} as AppConfig, createInMemoryStorage());
    try {
      const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
      const params = ensemblTranscriptResource.params!.parse({ id: 'ENST00000380152.8' });
      const result = await ensemblTranscriptResource.handler(params, ctx);
      expect(result).toMatchObject({
        id: 'ENST00000380152',
        parentGeneId: 'ENSG00000139618',
        isCanonical: true,
      });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        'https://rest.ensembl.org/lookup/id/ENST00000380152',
      ]);
    } finally {
      upstream.real = false;
      http.restore();
    }
  });

  it('describes the version suffix as dropped', () => {
    expect(ensemblTranscriptResource.params!.shape.id.description).toContain('dropped');
  });
});

/** `/lookup/id` records as rest.ensembl.org answers them, trimmed, keyed by the requested ID. */
const LOOKUP_ID = new Map<string, Record<string, unknown>>([
  [
    'ENST00000335295',
    {
      id: 'ENST00000335295',
      object_type: 'Transcript',
      Parent: 'ENSG00000244734',
      display_name: 'HBB-201',
      biotype: 'protein_coding',
      is_canonical: 1,
      species: 'homo_sapiens',
      seq_region_name: '11',
      start: 5225464,
      end: 5227071,
      strand: -1,
      length: 628,
      assembly_name: 'GRCh38',
    },
  ],
  // Also the ID of this transcript's translation; /lookup/id answers the Transcript.
  [
    'AT1G01010.1',
    {
      id: 'AT1G01010.1',
      object_type: 'Transcript',
      Parent: 'AT1G01010',
      display_name: 'NAC001-201',
      is_canonical: 1,
      species: 'arabidopsis_thaliana',
    },
  ],
  [
    'YFL039C_mRNA',
    {
      id: 'YFL039C_mRNA',
      object_type: 'Transcript',
      Parent: 'YFL039C',
      display_name: 'ACT1',
      is_canonical: 1,
      species: 'saccharomyces_cerevisiae',
    },
  ],
  [
    'LRG_1t1',
    { id: 'LRG_1t1', object_type: 'Transcript', Parent: 'LRG_1', is_canonical: 1, length: 5927 },
  ],
  [
    'ENSG00000244734',
    {
      id: 'ENSG00000244734',
      object_type: 'Gene',
      display_name: 'HBB',
      canonical_transcript: 'ENST00000335295.4',
      start: 5225464,
      end: 5229395,
    },
  ],
  // Also the ID of YFL039C_mRNA's translation; /lookup/id answers the Gene.
  [
    'YFL039C',
    { id: 'YFL039C', object_type: 'Gene', display_name: 'ACT1', start: 53260, end: 54696 },
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
  // A record that names no type: nothing in it says it is not a transcript.
  ['ENST00000380152', { id: 'ENST00000380152', Parent: 'ENSG00000139618', is_canonical: 1 }],
]);

/** Reads `id` through the real service over a `/lookup/id` fake, recording every request URL. */
async function readUpstream(id: string) {
  const http = createFetchMock([
    {
      match: /^https:\/\/rest\.ensembl\.org\/lookup\/id\//,
      respond: (request) => {
        const key = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!);
        const record = LOOKUP_ID.get(key);
        return record
          ? Response.json(record)
          : Response.json({ error: `ID '${key}' not found` }, { status: 400 });
      },
    },
  ]);
  http.install();
  upstream.real = true;
  initEnsemblService({} as AppConfig, createInMemoryStorage());
  try {
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id });
    const settled = await Promise.resolve(ensemblTranscriptResource.handler(params, ctx)).then(
      (value: unknown) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    return { ...settled, urls: http.calls.map((c) => c.request.url) };
  } finally {
    upstream.real = false;
    http.restore();
  }
}

describe('ensemblTranscriptResource object type (issue #63)', () => {
  it.each([
    ['ENST00000335295', 'ENSG00000244734'],
    ['AT1G01010.1', 'AT1G01010'],
    ['YFL039C_mRNA', 'YFL039C'],
    ['LRG_1t1', 'LRG_1'],
  ])('reads %s, a Transcript record, in one request', async (id, parentGeneId) => {
    const { value, error, urls } = await readUpstream(id);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ id, parentGeneId, isCanonical: true });
    expect(urls).toEqual([`https://rest.ensembl.org/lookup/id/${id}`]);
  });

  it.each([
    {
      id: 'ENSG00000244734',
      objectType: 'Gene',
      message: 'ENSG00000244734 is not a transcript: its Ensembl object_type is Gene.',
      hint: 'Read the gene with ensembl://gene/ENSG00000244734; its transcripts list names the transcript IDs this resource reads.',
    },
    {
      id: 'YFL039C',
      objectType: 'Gene',
      message: 'YFL039C is not a transcript: its Ensembl object_type is Gene.',
      hint: 'Read the gene with ensembl://gene/YFL039C; its transcripts list names the transcript IDs this resource reads.',
    },
    {
      id: 'ENSP00000333994',
      objectType: 'Translation',
      parentId: 'ENST00000335295',
      message:
        'ENSP00000333994 is not a transcript: its Ensembl object_type is Translation. Its parent is ENST00000335295.',
      hint: 'Read its transcript with ensembl://transcript/ENST00000335295, or the protein with ensembl_get_sequence (id ENSP00000333994, type "protein").',
    },
    {
      id: 'ENSE00001829867',
      objectType: 'Exon',
      message: 'ENSE00001829867 is not a transcript: its Ensembl object_type is Exon.',
      hint: "Read the exon's sequence with ensembl_get_sequence (id ENSE00001829867).",
    },
  ])('refuses $id (object_type $objectType) as wrong_object_type in one request', async (row) => {
    const { value, error, urls } = await readUpstream(row.id);
    expect(value).toBeUndefined();
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError, message: row.message });
    expect((error as { data: unknown }).data).toEqual({
      reason: 'wrong_object_type',
      objectType: row.objectType,
      ...(row.parentId && { parentId: row.parentId }),
      recovery: { hint: row.hint },
    });
    expect(urls).toEqual([`https://rest.ensembl.org/lookup/id/${row.id}`]);
  });

  it('leaves an object type it has no reader for to the declared recovery', async () => {
    const { error } = await readUpstream('ENSR00000000001');
    // No recovery at the throw site: the framework fills the contract's hint on the wire.
    expect((error as { data: unknown }).data).toEqual({
      reason: 'wrong_object_type',
      objectType: 'RegulatoryFeature',
    });
  });

  it('reads a record that names no object_type as the transcript, as before', async () => {
    const { value, error, urls } = await readUpstream('ENST00000380152');
    expect(error).toBeUndefined();
    expect(value).toEqual({
      id: 'ENST00000380152',
      parentGeneId: 'ENSG00000139618',
      isCanonical: true,
    });
    expect(urls).toEqual(['https://rest.ensembl.org/lookup/id/ENST00000380152']);
  });

  it('still maps an unknown ID to not_found', async () => {
    const { error, urls } = await readUpstream('ENST99999999999');
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    expect(urls).toHaveLength(1);
  });

  it('declares wrong_object_type as a ValidationError', () => {
    expect(
      ensemblTranscriptResource.errors!.find((e) => e.reason === 'wrong_object_type'),
    ).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });
});

describe('ensemblTranscriptResource classifies by error code, not message text (issue #63)', () => {
  it('maps a NotFound whose text never says "not found" to not_found', async () => {
    mockLookupTranscript.mockRejectedValueOnce(notFound('ENST00000000000 does not exist'));
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id: 'ENST00000000000' });
    await expect(ensemblTranscriptResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('passes another error through unchanged even when its text says "not found"', async () => {
    const outage = serviceUnavailable('Ensembl lookup backend not found; retry shortly.');
    mockLookupTranscript.mockRejectedValueOnce(outage);
    const ctx = createMockContext({ errors: ensemblTranscriptResource.errors });
    const params = ensemblTranscriptResource.params!.parse({ id: 'ENST00000380152' });
    await expect(ensemblTranscriptResource.handler(params, ctx)).rejects.toBe(outage);
  });
});
