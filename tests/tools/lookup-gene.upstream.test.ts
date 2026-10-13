/**
 * @fileoverview ensembl_lookup_gene through the real EnsemblService against a
 * strict fetch fake — the seam that includes URL building, error-envelope
 * mapping, the alias fallback, and the reference-region cache. Counts every
 * upstream request. Fixture IDs, names, and regions mirror rest.ensembl.org.
 * @module tests/tools/lookup-gene.upstream.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblLookupGene } from '@/mcp-server/tools/definitions/lookup-gene.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { RawGeneRecord } from '@/services/ensembl/types.js';

const LOOKUP_SYMBOL = /^https:\/\/rest\.ensembl\.org\/lookup\/symbol\//;
const LOOKUP_ID = /^https:\/\/rest\.ensembl\.org\/lookup\/id/;
const XREF = /^https:\/\/rest\.ensembl\.org\/xrefs\/symbol\//;
const ASSEMBLY = /^https:\/\/rest\.ensembl\.org\/info\/assembly\//;

const gene = (
  id: string,
  display_name: string,
  seq_region_name: string,
  species = 'homo_sapiens',
): RawGeneRecord => ({
  id,
  display_name,
  seq_region_name,
  species,
  biotype: 'protein_coding',
  start: 1000,
  end: 2000,
  strand: 1,
  assembly_name: species === 'zea_mays' ? 'Zm-B73-REFERENCE-NAM-5.0' : 'GRCh38',
  description: `${display_name} gene [Source:HGNC Symbol;Acc:HGNC:1]`,
  Transcript: [{ id: `${id}-T1`, is_canonical: 1, biotype: 'protein_coding' }],
});

/** Every gene the fake can return by stable ID. */
const GENES: Record<string, RawGeneRecord> = {
  ENSG00000139618: gene('ENSG00000139618', 'BRCA2', '13'),
  ENSG00000141510: gene('ENSG00000141510', 'TP53', '17'),
  Zm00001eb054440: gene('Zm00001eb054440', 'TCP1', '1', 'zea_mays'),
  ENSG00000141736: gene('ENSG00000141736', 'ERBB2', '17'),
  ENSG00000185803: gene('ENSG00000185803', 'SLC52A2', '8'),
  ENSG00000285112: gene('ENSG00000285112', 'SLC52A2', 'HG2419_PATCH'),
  ENSG00000085563: gene('ENSG00000085563', 'ABCB1', '7'),
  ENSG00000109436: gene('ENSG00000109436', 'TBC1D9', '4'),
  ENSG00000999901: gene('ENSG00000999901', 'PATCHY1', 'HSCHR1_1_CTG3'),
  ENSG00000999902: gene('ENSG00000999902', 'PATCHY2', 'HSCHR2_1_CTG5'),
  'AT3G52430.1': gene('AT3G52430.1', 'PAD4-201', '3', 'arabidopsis_thaliana'),
};

/** Current display names `/lookup/symbol` matches (case-insensitively, like Ensembl). */
const DIRECT: Record<string, string> = {
  BRCA2: 'ENSG00000139618',
  TP53: 'ENSG00000141510',
};

/** What `/xrefs/symbol/…?object_type=gene` returns per upper-cased name. */
const XREFS: Record<string, string[]> = {
  TB1: ['Zm00001eb054440'],
  HER2: ['ENSG00000141736', 'LRG_724'],
  GPR172A: ['ENSG00000185803', 'ENSG00000285112'],
  MDR1: ['ENSG00000085563', 'ENSG00000109436'],
  PATCHY: ['ENSG00000999901', 'ENSG00000999902'],
};

const SPECIES = new Set(['homo_sapiens', 'zea_mays']);

const REFERENCE_REGIONS = [...Array.from({ length: 22 }, (_, i) => `${i + 1}`), 'X', 'Y', 'MT'];

const badSpecies = (species: string) =>
  Response.json({ error: `Can not find internal name for species '${species}'` }, { status: 400 });

/** In-flight bookkeeping for the xref endpoint, reset per test. */
let xrefEvents: string[] = [];
let xrefInFlight = 0;
let xrefMaxInFlight = 0;

async function ensembl(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] === 'lookup' && parts[1] === 'symbol') {
    const species = parts[2]!;
    if (request.method === 'POST') {
      // Ensembl answers an unknown species and an all-miss batch with the same {}.
      const { symbols } = (await request.json()) as { symbols: string[] };
      const body: Record<string, RawGeneRecord> = {};
      for (const s of symbols) {
        const id = DIRECT[s.toUpperCase()];
        if (SPECIES.has(species) && id) body[s] = GENES[id]!;
      }
      return Response.json(body);
    }
    if (!SPECIES.has(species)) return badSpecies(species);
    const id = DIRECT[parts[3]!.toUpperCase()];
    return id
      ? Response.json(GENES[id])
      : Response.json({ error: `No valid lookup found for symbol ${parts[3]}` }, { status: 400 });
  }

  if (parts[0] === 'lookup' && parts[1] === 'id' && request.method === 'POST') {
    const { ids } = (await request.json()) as { ids: string[] };
    return Response.json(Object.fromEntries(ids.map((id) => [id, GENES[id] ?? null])));
  }

  if (parts[0] === 'lookup' && parts[1] === 'id') {
    // Like Ensembl, a versioned stable ID is not found, even for the current version.
    const record = GENES[parts[2]!];
    return record
      ? Response.json(record)
      : Response.json({ error: `ID '${parts[2]}' not found` }, { status: 400 });
  }

  if (parts[0] === 'xrefs' && parts[1] === 'symbol') {
    const [species, symbol] = [parts[2]!, parts[3]!];
    xrefEvents.push(`start:${symbol}`);
    xrefInFlight++;
    xrefMaxInFlight = Math.max(xrefMaxInFlight, xrefInFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    xrefInFlight--;
    xrefEvents.push(`end:${symbol}`);
    if (!SPECIES.has(species)) return badSpecies(species);
    const ids = XREFS[symbol.toUpperCase()] ?? [];
    return Response.json(ids.map((id) => ({ id, type: 'gene' })));
  }

  if (parts[0] === 'info' && parts[1] === 'assembly') {
    return Response.json({
      assembly_name: 'GRCh38.p14',
      default_coord_system_version: 'GRCh38',
      top_level_region: REFERENCE_REGIONS.map((name) => ({ name, coord_system: 'chromosome' })),
    });
  }

  throw new Error(`Unrouted Ensembl request: ${request.method} ${request.url}`);
}

let http: FetchMockHarness;

beforeEach(() => {
  // Strict: an unrouted request throws, so an unexpected upstream call fails the test.
  http = createFetchMock();
  http.route({ match: () => true, respond: ensembl });
  http.install();
  initEnsemblService({} as AppConfig, createInMemoryStorage());
  xrefEvents = [];
  xrefInFlight = 0;
  xrefMaxInFlight = 0;
});

afterEach(() => {
  http.restore();
});

const requests = (pattern: RegExp) => http.calls.filter((c) => pattern.test(c.request.url));

type ToolContractResult = Awaited<ReturnType<typeof runToolContract>>;

function contentText(result: ToolContractResult): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const recoveryOf = (reason: string) =>
  ensemblLookupGene.errors!.find((e) => e.reason === reason)!.recovery;

async function lookupIdBody(): Promise<{ ids: string[]; expand?: number }> {
  const [call] = requests(LOOKUP_ID);
  return (await call!.request.clone().json()) as { ids: string[]; expand?: number };
}

describe('ensembl_lookup_gene single symbol (issue #20)', () => {
  it('resolves a current symbol with one request', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'BRCA2' });
    expect(result.structuredContent).toMatchObject({ gene: { id: 'ENSG00000139618' } });
    expect((result.structuredContent as { gene: object }).gene).not.toHaveProperty('matchedAlias');
    expect(http.calls).toHaveLength(1);
  });

  it('classifies an unrecognized species as invalid_species with no xref request', async () => {
    const result = await runToolContract(ensemblLookupGene, {
      symbol: 'BRCA2',
      species: 'not_a_species',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: { reason: 'invalid_species', recovery: { hint: recoveryOf('invalid_species') } },
      },
    });
    expect(http.calls).toHaveLength(1);
    expect(requests(XREF)).toHaveLength(0);
  });

  it('resolves TB1 on zea_mays through its alias after 3 requests', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'TB1', species: 'zea_mays' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      gene: { id: 'Zm00001eb054440', displayName: 'TCP1', matchedAlias: 'TB1' },
    });
    expect(contentText(result)).toContain('**Matched alias:** TB1');
    expect(http.calls).toHaveLength(3);
    expect(requests(XREF)[0]!.request.url).toBe(
      'https://rest.ensembl.org/xrefs/symbol/zea_mays/TB1?object_type=gene',
    );
    expect(requests(ASSEMBLY)).toHaveLength(0);
  });

  it('drops the LRG record so HER2 resolves to ERBB2, not an ambiguity', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'HER2' });
    expect(result.structuredContent).toMatchObject({
      gene: { id: 'ENSG00000141736', displayName: 'ERBB2', matchedAlias: 'HER2' },
    });
    expect(result.structuredContent).not.toHaveProperty('ambiguous');
    expect((await lookupIdBody()).ids).toEqual(['ENSG00000141736']);
    expect(http.calls).toHaveLength(3);
  });

  it('excludes the patch copy of GPR172A using the reference regions (4 requests)', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'GPR172A' });
    expect(result.structuredContent).toMatchObject({
      gene: { id: 'ENSG00000185803', chromosome: '8', matchedAlias: 'GPR172A' },
    });
    expect(http.calls).toHaveLength(4);
    expect(requests(ASSEMBLY)[0]!.request.url).toBe(
      'https://rest.ensembl.org/info/assembly/homo_sapiens',
    );
  });

  it('fetches the reference regions once per species for the process', async () => {
    await runToolContract(ensemblLookupGene, { symbol: 'GPR172A' });
    const second = await runToolContract(ensemblLookupGene, { symbol: 'GPR172A' });
    expect(second.structuredContent).toMatchObject({ gene: { id: 'ENSG00000185803' } });
    expect(requests(ASSEMBLY)).toHaveLength(1);
    expect(http.calls).toHaveLength(7);
  });

  it('returns MDR1 as ambiguous with both genes and no gene field (4 requests)', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'MDR1' });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      gene?: unknown;
      ambiguous: { query: string; candidates: { id: string }[]; guidance: string };
    };
    expect(structured.gene).toBeUndefined();
    expect(structured.ambiguous.query).toBe('MDR1');
    expect(structured.ambiguous.candidates.map((c) => c.id)).toEqual([
      'ENSG00000085563',
      'ENSG00000109436',
    ]);
    expect(structured.ambiguous.guidance).toContain('id');
    expect(structured.ambiguous.guidance).toContain('ENSG00000085563');
    const text = contentText(result);
    expect(text).toContain('## Ambiguous symbol: MDR1');
    expect(text).toContain('### ABCB1');
    expect(text).toContain('### TBC1D9');
    expect(text).toContain('**Chromosome:** 4');
    expect(text).toContain(structured.ambiguous.guidance);
    expect(http.calls).toHaveLength(4);
  });

  it('keeps every candidate when the region filter would drop them all', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'PATCHY' });
    const structured = result.structuredContent as { ambiguous: { candidates: { id: string }[] } };
    expect(structured.ambiguous.candidates.map((c) => c.id)).toEqual([
      'ENSG00000999901',
      'ENSG00000999902',
    ]);
  });

  it('throws not_found for an unknown symbol after 2 requests', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbol: 'NO_SUCH_GENE_ABC' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'not_found', recovery: { hint: recoveryOf('not_found') } } },
    });
    expect(http.calls).toHaveLength(2);
    expect(requests(LOOKUP_ID)).toHaveLength(0);
  });

  it('honors expand_transcripts on the candidate lookup', async () => {
    const result = await runToolContract(ensemblLookupGene, {
      symbol: 'TB1',
      species: 'zea_mays',
      expand_transcripts: true,
    });
    expect(result.structuredContent).toMatchObject({
      gene: { transcripts: [{ id: 'Zm00001eb054440-T1', isCanonical: true }] },
    });
    expect((await lookupIdBody()).expand).toBe(1);
  });

  it('propagates an upstream error that is not a direct miss without an xref request', async () => {
    http.reset();
    http.route({
      match: LOOKUP_SYMBOL,
      respond: () => Response.json({ error: 'Something unexpected happened' }, { status: 400 }),
    });
    const result = await runToolContract(ensemblLookupGene, { symbol: 'BRCA2' });
    expect(result.isError).toBe(true);
    expect(errorReason(result)).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });
});

function errorReason(result: ToolContractResult): unknown {
  return (result.structuredContent as { error?: { data?: { reason?: unknown } } }).error?.data
    ?.reason;
}

describe('ensembl_lookup_gene batch (issues #18, #20)', () => {
  it('throws invalid_species for a symbols batch on an unrecognized species after one xref request', async () => {
    const result = await runToolContract(ensemblLookupGene, {
      symbols: ['BRCA2', 'TP53', 'HER2'],
      species: 'not_a_species',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: { reason: 'invalid_species', recovery: { hint: recoveryOf('invalid_species') } },
      },
    });
    expect(requests(LOOKUP_SYMBOL)).toHaveLength(1);
    expect(requests(XREF)).toHaveLength(1);
    expect(http.calls).toHaveLength(2);
  });

  it('lists every symbol of an all-miss batch on a valid species as not_found', async () => {
    const symbols = ['NOPE_A', 'NOPE_B', 'NOPE_C'];
    const result = await runToolContract(ensemblLookupGene, { symbols });
    expect(result.isError).toBeUndefined();
    const batch = (
      result.structuredContent as {
        batch: { succeeded: unknown[]; failed: Record<string, unknown>[] };
      }
    ).batch;
    expect(batch.succeeded).toEqual([]);
    expect(batch.failed.map((f) => [f.query, f.reason, f.recovery])).toEqual(
      symbols.map((s) => [s, 'not_found', recoveryOf('not_found')]),
    );
    expect(requests(XREF)).toHaveLength(3);
    expect(requests(LOOKUP_ID)).toHaveLength(0);
    expect(http.calls).toHaveLength(4);
  });

  it('runs the first miss alone as the species check when nothing resolved directly', async () => {
    await runToolContract(ensemblLookupGene, { symbols: ['NOPE_A', 'NOPE_B', 'NOPE_C'] });
    expect(xrefEvents.slice(0, 2)).toEqual(['start:NOPE_A', 'end:NOPE_A']);
  });

  it('sends no species check when a symbol resolved directly', async () => {
    await runToolContract(ensemblLookupGene, { symbols: ['BRCA2', 'NOPE_A', 'NOPE_B'] });
    // Both misses start before either finishes: no lone first request.
    expect(xrefEvents.slice(0, 2)).toEqual(['start:NOPE_A', 'start:NOPE_B']);
    expect(requests(XREF)).toHaveLength(2);
  });

  it('keeps at most 4 xref requests in flight', async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => `NOPE_${i}`);
    await runToolContract(ensemblLookupGene, { symbols: ['BRCA2', ...symbols] });
    expect(requests(XREF)).toHaveLength(10);
    expect(xrefMaxInFlight).toBe(4);
  });

  it('starts no further xref request once one has failed the batch', async () => {
    const symbols = ['BRCA2', 'BROKEN', ...Array.from({ length: 8 }, (_, i) => `NOPE_${i}`)];
    http.reset();
    http.route({
      match: /\/xrefs\/symbol\/homo_sapiens\/BROKEN\?/,
      respond: () => Response.json({ error: 'Something unexpected happened' }, { status: 400 }),
    });
    http.route({ match: () => true, respond: ensembl });
    const result = await runToolContract(ensemblLookupGene, { symbols });
    expect(result.isError).toBe(true);
    // Let any worker still running finish its in-flight request and try to start another.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The first wave: BROKEN plus the three requests already in flight beside it.
    expect(requests(XREF)).toHaveLength(4);
  });

  it('lists a symbol the xref route cannot address as not_found, keeping the batch', async () => {
    // Ensembl decodes %2F before routing, so a symbol with a slash 404s as an unknown page.
    http.reset();
    http.route({
      match: /\/xrefs\/symbol\/homo_sapiens\/foo%2Fbar\?/,
      respond: () =>
        Response.json(
          {
            error:
              'page not found. Please check your uri and refer to our documentation https://rest.ensembl.org/',
          },
          { status: 404 },
        ),
    });
    http.route({ match: () => true, respond: ensembl });
    const result = await runToolContract(ensemblLookupGene, {
      symbols: ['BRCA2', 'foo/bar', 'HER2'],
    });
    expect(result.isError).toBeUndefined();
    const { succeeded, failed } = (
      result.structuredContent as {
        batch: { succeeded: Record<string, unknown>[]; failed: Record<string, unknown>[] };
      }
    ).batch;
    expect(succeeded.map((g) => [g.query, g.matchedAlias])).toEqual([
      ['BRCA2', undefined],
      ['HER2', 'HER2'],
    ]);
    expect(failed).toEqual([
      {
        query: 'foo/bar',
        reason: 'not_found',
        error: 'Symbol foo/bar not found in Ensembl for species homo_sapiens.',
        recovery: recoveryOf('not_found'),
      },
    ]);
  });

  it('makes exactly one request for a fully resolved symbols batch', async () => {
    const result = await runToolContract(ensemblLookupGene, { symbols: ['brca2', 'Tp53'] });
    expect(result.structuredContent).toMatchObject({
      batch: {
        succeeded: [
          { query: 'brca2', id: 'ENSG00000139618' },
          { query: 'Tp53', id: 'ENSG00000141510' },
        ],
        failed: [],
      },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('makes exactly one request for an ids batch, with typed failed items', async () => {
    const result = await runToolContract(ensemblLookupGene, {
      ids: ['ENSG99999999999', 'ENSG00000139618'],
    });
    expect(result.structuredContent).toMatchObject({
      batch: {
        succeeded: [{ query: 'ENSG00000139618', id: 'ENSG00000139618' }],
        failed: [
          {
            query: 'ENSG99999999999',
            reason: 'not_found',
            error: 'ID ENSG99999999999 not found in Ensembl.',
            recovery: recoveryOf('not_found'),
          },
        ],
      },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('resolves a mixed batch: direct hit, alias hit, ambiguous, patch filter, and miss', async () => {
    const result = await runToolContract(ensemblLookupGene, {
      symbols: ['MDR1', 'brca2', 'HER2', 'NO_SUCH_GENE_ABC', 'GPR172A'],
    });
    const { succeeded, failed } = (
      result.structuredContent as {
        batch: { succeeded: Record<string, unknown>[]; failed: Record<string, unknown>[] };
      }
    ).batch;

    // Input order, each carrying the submitted query.
    expect(succeeded.map((g) => [g.query, g.id, g.matchedAlias])).toEqual([
      ['brca2', 'ENSG00000139618', undefined],
      ['HER2', 'ENSG00000141736', 'HER2'],
      ['GPR172A', 'ENSG00000185803', 'GPR172A'],
    ]);
    const [ambiguous, missing] = failed;
    expect(ambiguous).toMatchObject({
      query: 'MDR1',
      reason: 'ambiguous',
      error: 'Symbol MDR1 maps to 2 genes in homo_sapiens.',
    });
    expect((ambiguous!.candidates as { id: string }[]).map((c) => c.id)).toEqual([
      'ENSG00000085563',
      'ENSG00000109436',
    ]);
    expect(ambiguous!.recovery).toContain('ABCB1 (ENSG00000085563), TBC1D9 (ENSG00000109436)');
    expect(ambiguous!.recovery).toContain('with id set to');
    expect(missing).toEqual({
      query: 'NO_SUCH_GENE_ABC',
      reason: 'not_found',
      error: 'Symbol NO_SUCH_GENE_ABC not found in Ensembl for species homo_sapiens.',
      recovery: recoveryOf('not_found'),
    });

    // 1 batch POST + 4 xrefs + 1 POST /lookup/id + 1 assembly fetch.
    expect(requests(LOOKUP_SYMBOL)).toHaveLength(1);
    expect(requests(XREF)).toHaveLength(4);
    expect(requests(LOOKUP_ID)).toHaveLength(1);
    expect(requests(ASSEMBLY)).toHaveLength(1);
    expect(http.calls).toHaveLength(7);
    expect((await lookupIdBody()).ids.sort()).toEqual(
      [
        'ENSG00000085563',
        'ENSG00000109436',
        'ENSG00000141736',
        'ENSG00000185803',
        'ENSG00000285112',
      ].sort(),
    );

    const text = contentText(result);
    expect(text).toContain('**Query:** HER2');
    expect(text).toContain('**Matched alias:** HER2');
    expect(text).toContain('- **MDR1** (ambiguous)');
    expect(text).toContain('#### TBC1D9');
    expect(text).toContain(recoveryOf('not_found'));
    expect(text).toContain(ambiguous!.recovery as string);
  });
});

describe('ensembl_lookup_gene symbols batch when Ensembl does not answer an alias lookup', () => {
  const XREF_OF = (symbol: string) => new RegExp(`/xrefs/symbol/[^/]+/${symbol}\\?`);
  const html503 = () =>
    new Response('<!DOCTYPE html><html><body>503 Service Unavailable</body></html>', {
      status: 503,
      headers: { 'content-type': 'text/html' },
    });

  /** Re-routes the fake: the given patterns answer an HTML 503 on every attempt. */
  const routeWithOutage = (...down: RegExp[]) => {
    http.reset();
    for (const match of down) http.route({ match, respond: html503 });
    http.route({ match: () => true, respond: ensembl });
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs a call to completion, stepping the fake clock through every retry backoff. */
  async function settle(run: Promise<ToolContractResult>): Promise<ToolContractResult> {
    let done = false;
    const tracked = run.finally(() => {
      done = true;
    });
    while (!done) await vi.advanceTimersByTimeAsync(250);
    return tracked;
  }

  type Batch = { succeeded: Record<string, unknown>[]; failed: Record<string, unknown>[] };
  const batchOf = (result: ToolContractResult) =>
    (result.structuredContent as { batch: Batch }).batch;

  it('keeps direct and alias hits when one miss fails after its retries', async () => {
    routeWithOutage(XREF_OF('BROKEN'));
    const result = await settle(
      runToolContract(ensemblLookupGene, { symbols: ['BRCA2', 'BROKEN', 'HER2', 'NOPE_A'] }),
    );
    expect(result.isError).toBeUndefined();
    const { succeeded, failed } = batchOf(result);
    expect(succeeded.map((g) => [g.query, g.id, g.matchedAlias])).toEqual([
      ['BRCA2', 'ENSG00000139618', undefined],
      ['HER2', 'ENSG00000141736', 'HER2'],
    ]);
    expect(failed.map((f) => [f.query, f.reason])).toEqual([
      ['BROKEN', 'unavailable'],
      ['NOPE_A', 'not_found'],
    ]);
    const [unavailable] = failed;
    expect(unavailable!.error).toContain('BROKEN');
    expect(unavailable!.error).toContain('failed after 4 attempts');
    expect(unavailable!.recovery).toMatch(/retry/i);
    expect(unavailable!.recovery).toContain('symbol');
    // The failing miss was retried; every other request ran once.
    expect(requests(XREF_OF('BROKEN'))).toHaveLength(4);
    expect(requests(XREF)).toHaveLength(6);
    expect(requests(LOOKUP_ID)).toHaveLength(1);

    const text = contentText(result);
    expect(text).toContain('**Succeeded:** 2 | **Failed:** 2');
    expect(text).toContain('- **BROKEN** (unavailable)');
    expect(text).toContain(unavailable!.recovery as string);
  });

  it('runs the remaining misses when the species-check miss fails, and reports no species verdict', async () => {
    routeWithOutage(XREF_OF('BROKEN'));
    const result = await settle(
      runToolContract(ensemblLookupGene, { symbols: ['BROKEN', 'HER2', 'NOPE_A'] }),
    );
    expect(result.isError).toBeUndefined();
    const { succeeded, failed } = batchOf(result);
    expect(succeeded.map((g) => [g.query, g.matchedAlias])).toEqual([['HER2', 'HER2']]);
    expect(failed.map((f) => [f.query, f.reason])).toEqual([
      ['BROKEN', 'unavailable'],
      ['NOPE_A', 'not_found'],
    ]);
    // The species check ran alone first: its four attempts precede every other xref.
    const order = requests(XREF).map((c) => new URL(c.request.url).pathname.split('/').at(-1));
    expect(order.slice(0, 4)).toEqual(['BROKEN', 'BROKEN', 'BROKEN', 'BROKEN']);
    expect(order.slice(4).sort()).toEqual(['HER2', 'NOPE_A']);
  });

  it('still throws invalid_species when a later miss shows the species is unknown', async () => {
    routeWithOutage(XREF_OF('BROKEN'));
    const result = await settle(
      runToolContract(ensemblLookupGene, {
        symbols: ['BROKEN', 'NOPE_A'],
        species: 'not_a_species',
      }),
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'invalid_species' } },
    });
  });

  it('reports an unanswered species check as unavailable, never as an invalid species', async () => {
    routeWithOutage(XREF_OF('BROKEN'));
    const result = await settle(
      runToolContract(ensemblLookupGene, { symbols: ['BROKEN'], species: 'not_a_species' }),
    );
    expect(result.isError).toBeUndefined();
    expect(batchOf(result).failed.map((f) => [f.query, f.reason])).toEqual([
      ['BROKEN', 'unavailable'],
    ]);
  });

  it('marks alias candidates unavailable when their gene lookup fails, keeping the rest', async () => {
    routeWithOutage(LOOKUP_ID);
    const result = await settle(
      runToolContract(ensemblLookupGene, { symbols: ['BRCA2', 'HER2', 'NOPE_A'] }),
    );
    expect(result.isError).toBeUndefined();
    const { succeeded, failed } = batchOf(result);
    expect(succeeded.map((g) => g.query)).toEqual(['BRCA2']);
    expect(failed.map((f) => [f.query, f.reason])).toEqual([
      ['HER2', 'unavailable'],
      ['NOPE_A', 'not_found'],
    ]);
  });

  it('keeps throwing ServiceUnavailable for a single symbol whose alias lookup fails', async () => {
    routeWithOutage(XREF_OF('BROKEN'));
    const result = await settle(runToolContract(ensemblLookupGene, { symbol: 'BROKEN' }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32000 } });
    expect(errorReason(result)).toBeUndefined();
  });

  it('fails a cancelled batch as cancelled, never as a degraded success', async () => {
    const controller = new AbortController();
    http.reset();
    http.route({
      match: XREF_OF('BROKEN'),
      respond: () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });
    http.route({ match: () => true, respond: ensembl });
    const result = await settle(
      runToolContract(
        ensemblLookupGene,
        { symbols: ['BRCA2', 'BROKEN', 'HER2'] },
        { context: { signal: controller.signal } },
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect((result.structuredContent as Record<string, unknown>).batch).toBeUndefined();
  });

  it('documents the unavailable reason on the failed-item output', () => {
    const description = JSON.stringify(z.toJSONSchema(ensemblLookupGene.output));
    expect(description).toContain('unavailable');
  });
});

describe('ensembl_lookup_gene versioned stable IDs (issue #41)', () => {
  it('resolves a versioned id to the current record', async () => {
    const result = await runToolContract(ensemblLookupGene, { id: 'ENSG00000139618.19' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      gene: { id: 'ENSG00000139618', displayName: 'BRCA2' },
    });
    expect(contentText(result)).toContain('**ID:** ENSG00000139618');
    expect(http.calls.map((c) => c.request.url)).toEqual([
      'https://rest.ensembl.org/lookup/id/ENSG00000139618',
    ]);
  });

  it('keeps not_found for a versioned ID Ensembl does not hold', async () => {
    const result = await runToolContract(ensemblLookupGene, { id: 'ENSG99999999999.4' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'not_found', recovery: { hint: recoveryOf('not_found') } },
      },
    });
    expect(contentText(result)).toContain('Gene ID "ENSG99999999999.4" not found in Ensembl.');
    expect(http.calls[0]?.request.url).toBe('https://rest.ensembl.org/lookup/id/ENSG99999999999');
  });

  it('resolves an ids batch in one request, each item echoing the ID as submitted', async () => {
    const result = await runToolContract(ensemblLookupGene, {
      ids: [
        'ENSG00000139618.19',
        'ENSG00000141510.21',
        'ENSG00000139618',
        'AT3G52430.1',
        'ENSG99999999999.2',
        'ENSG00000139618.19',
      ],
    });
    const { succeeded, failed } = (
      result.structuredContent as {
        batch: { succeeded: Record<string, unknown>[]; failed: Record<string, unknown>[] };
      }
    ).batch;
    // Inputs that differ only by version are separate items with the same record.
    expect(succeeded.map((g) => [g.query, g.id])).toEqual([
      ['ENSG00000139618.19', 'ENSG00000139618'],
      ['ENSG00000141510.21', 'ENSG00000141510'],
      ['ENSG00000139618', 'ENSG00000139618'],
      ['AT3G52430.1', 'AT3G52430.1'],
    ]);
    expect(failed).toEqual([
      {
        query: 'ENSG99999999999.2',
        reason: 'not_found',
        error: 'ID ENSG99999999999.2 not found in Ensembl.',
        recovery: recoveryOf('not_found'),
      },
    ]);
    expect(http.calls).toHaveLength(1);
    expect((await lookupIdBody()).ids).toEqual([
      'ENSG00000139618',
      'ENSG00000141510',
      'AT3G52430.1',
      'ENSG99999999999',
    ]);
    const text = contentText(result);
    expect(text).toContain('**Query:** ENSG00000139618.19');
    expect(text).toContain('**Succeeded:** 4 | **Failed:** 1');
  });

  it('describes the version handling on id and ids', () => {
    const { id, ids } = ensemblLookupGene.input.shape;
    expect(id.description).toContain('version suffix');
    expect(ids.description).toContain('version suffix');
    expect(ids.description).toContain('as submitted');
    expect(recoveryOf('not_found')).not.toContain('omitting the version');
  });
});
