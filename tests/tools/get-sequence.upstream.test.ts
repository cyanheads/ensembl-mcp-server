/**
 * @fileoverview ensembl_get_sequence through the real EnsemblService against a
 * strict fetch fake — the seam that includes URL building, error-envelope
 * mapping, and normalization. Counts every upstream request.
 * @module tests/tools/get-sequence.upstream.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensemblGetSequence } from '@/mcp-server/tools/definitions/get-sequence.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';

const SEQUENCE_ID = /^https:\/\/rest\.ensembl\.org\/sequence\/id\//;
const SEQUENCE_REGION = /^https:\/\/rest\.ensembl\.org\/sequence\/region\//;

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

let http: FetchMockHarness;

beforeEach(() => {
  // Strict: an unrouted request throws, so an unexpected upstream call fails the test.
  http = createFetchMock();
  http.install();
  initEnsemblService({} as AppConfig, createInMemoryStorage());
});

afterEach(() => {
  http.restore();
});

describe('ensembl_get_sequence upstream requests', () => {
  it('sends a region request with no type parameter when type is omitted', async () => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () =>
        Response.json({
          id: 'chromosome:GRCh38:13:32315086:32315100:1',
          molecule: 'dna',
          seq: 'AAGCTTTTGTAAGAT',
          query: '13:32315086-32315100',
        }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: '13:32315086-32315100',
      species: 'homo_sapiens',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      type: 'genomic',
      seq: 'AAGCTTTTGTAAGAT',
      length: 15,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/region/homo_sapiens/13%3A32315086-32315100',
    );
  });

  it('forwards expansion on an explicit genomic region request', async () => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () => Response.json({ id: 'chromosome:GRCh38:13:1:1', seq: dna(35) }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'homo_sapiens:13:32315086-32315100',
      type: 'genomic',
      expand_5prime: 10,
      expand_3prime: 10,
    });
    expect(result.structuredContent).toMatchObject({ type: 'genomic', length: 35 });
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/region/homo_sapiens/13%3A32315086-32315100?expand_5prime=10&expand_3prime=10',
    );
  });

  it('returns a short protein whole from a transcript ID', async () => {
    const protein = 'MPIGSKERPTFFEIFKTRCNKADLTHGGFKV';
    http.route({
      match: SEQUENCE_ID,
      respond: () => Response.json({ id: 'ENSP00000369497', molecule: 'protein', seq: protein }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENST00000380152',
      type: 'protein',
    });
    expect(result.structuredContent).toMatchObject({ type: 'protein', seq: protein, length: 31 });
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/id/ENST00000380152?type=protein',
    );
  });

  it('classifies the gene-ID multiple-sequences rejection as type_mismatch', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () =>
        Response.json(
          {
            error:
              'Requesting a gene and type not equal to "genomic" can result in multiple sequences. 15 sequences detected.',
          },
          { status: 400 },
        ),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENSG00000139618',
      type: 'protein',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'type_mismatch' } },
    });
    expect(http.calls).toHaveLength(1);
  });
});

describe('ensembl_get_sequence region syntax and error mapping', () => {
  const regionRow = (seq: string) => () =>
    Response.json({ id: 'chromosome:GRCh38:1:1:1:1', molecule: 'dna', seq });

  it.each([
    ['a chr-prefixed bare region', { id: 'chr13:32315086-32315100', species: 'homo_sapiens' }],
    ['a dotted scaffold name', { id: 'GL000220.1:1-100', species: 'homo_sapiens' }],
    ['a prefixed dotted scaffold name', { id: 'homo_sapiens:GL000220.1:1-100' }],
    ['a zero start', { id: '1:0-100', species: 'homo_sapiens' }],
    ['a single-base region (start equals end)', { id: '1:100-100', species: 'homo_sapiens' }],
    ['zero-padded coordinates in order', { id: '1:0900-1000', species: 'homo_sapiens' }],
  ])('forwards %s to the region endpoint unchanged', async (_label, args) => {
    http.route({ match: SEQUENCE_REGION, respond: regionRow('ACGT') });
    const result = await runToolContract(ensemblGetSequence, args);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ type: 'genomic', seq: 'ACGT' });
    expect(http.calls).toHaveLength(1);
    const region = args.id.startsWith('homo_sapiens:')
      ? args.id.slice('homo_sapiens:'.length)
      : args.id;
    expect(http.calls[0]?.request.url).toBe(
      `https://rest.ensembl.org/sequence/region/homo_sapiens/${encodeURIComponent(region)}`,
    );
  });

  it('classifies a region "not found" rejection as not_found', async () => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () => Response.json({ error: 'Region 1:1-100 not found' }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: '1:1-100',
      species: 'homo_sapiens',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32001, data: { reason: 'not_found' } },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('classifies an unknown stable ID as not_found', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () => Response.json({ error: "ID 'ENSG99999999999' not found" }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSG99999999999' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32001, data: { reason: 'not_found' } },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('routes a decimal-coordinate region to stable-ID mode, where it is not_found', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () => Response.json({ error: "ID '1:1-5000000.5' not found" }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: '1:1-5000000.5',
      species: 'homo_sapiens',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32001, data: { reason: 'not_found' } },
    });
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/id/1%3A1-5000000.5?type=genomic',
    );
  });
});

describe('ensembl_get_sequence invalid_region (issue #28)', () => {
  const recovery = () =>
    ensemblGetSequence.errors!.find((e) => e.reason === 'invalid_region')!.recovery;

  /** Concatenated text of every `content[]` block — what a `content`-only client reads. */
  const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

  it.each([
    [
      'an out-of-bounds start',
      { id: '1:250000000-250000100', species: 'homo_sapiens' },
      'Cannot request a slice whose start (250000000) is greater than 248956422 for 1.',
    ],
    [
      'a region over the 10,000,000-base limit',
      { id: '1:1-20000001', species: 'homo_sapiens' },
      '20000001 is greater than the maximum allowed length of 10000000. Request smaller regions of sequence',
    ],
    [
      'a region one base over the limit (prefixed form)',
      { id: 'homo_sapiens:1:1-10000001' },
      '10000001 is greater than the maximum allowed length of 10000000. Request smaller regions of sequence',
    ],
    [
      'an unknown sequence region',
      { id: '1000:1-100', species: 'homo_sapiens' },
      'No slice found for location 1000:1-100',
    ],
  ])('classifies the upstream rejection of %s as invalid_region', async (_label, args, error) => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () => Response.json({ error }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'invalid_region', recovery: { hint: recovery() } } },
    });
    const text = contentText(result);
    expect(text).toContain(error);
    expect(text).toContain('10,000,000');
    expect(text).toContain('(reason invalid_region)');
    // A 400 input rejection is never retried as an outage.
    expect(http.calls).toHaveLength(1);
  });

  it('serves a region exactly at the 10,000,000-base limit', async () => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () => Response.json({ id: 'chromosome:GRCh38:1:1:10000000:1', seq: dna(20) }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: '1:1-10000000',
      species: 'homo_sapiens',
    });
    expect(result.isError).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ['bare', { id: '1:500-100', species: 'homo_sapiens' }],
    ['prefixed', { id: 'homo_sapiens:X:500-100' }],
    ['off-by-one', { id: '1:101-100', species: 'homo_sapiens' }],
    ['zero-padded', { id: '1:500-0100', species: 'homo_sapiens' }],
    [
      'beyond double precision',
      { id: '1:100000000000000000001-100000000000000000000', species: 'homo_sapiens' },
    ],
  ])('rejects %s reversed coordinates locally, before any request', async (_label, args) => {
    const result = await runToolContract(ensemblGetSequence, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'invalid_region', recovery: { hint: recovery() } } },
    });
    const text = contentText(result);
    expect(text).toContain('start');
    expect(text).toContain('greater than its end');
    expect(text).toContain('(reason invalid_region)');
    expect(http.calls).toHaveLength(0);
  });

  it('checks a non-genomic type before the coordinates', async () => {
    const result = await runToolContract(ensemblGetSequence, {
      id: '1:500-100',
      species: 'homo_sapiens',
      type: 'protein',
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'type_mismatch' } },
    });
    expect(http.calls).toHaveLength(0);
  });
});

describe('ensembl_get_sequence stable-ID error classification (issue #28)', () => {
  it('classifies an echoed ID that reads like a type mismatch as not_found', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () =>
        Response.json({ error: "ID 'my_protein_gene_type_mismatch' not found" }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'my_protein_gene_type_mismatch',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32001, data: { reason: 'not_found' } },
    });
  });

  it('classifies a long adversarial upstream message in linear time', async () => {
    const echo = 'protein'.repeat(11_500); // ~80k characters, no "gene" to find
    http.route({
      match: SEQUENCE_ID,
      respond: () => Response.json({ error: `Could not process ${echo}` }, { status: 400 }),
    });
    const started = performance.now();
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000139618' });
    const elapsed = performance.now() - started;
    expect(result.isError).toBe(true);
    // Unrecognized, so it passes through without a declared reason.
    expect(result.structuredContent).toMatchObject({ error: { code: -32001 } });
    expect(
      (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).toBeUndefined();
    // The backtracking pattern took over a second here; a linear scan takes milliseconds.
    expect(elapsed).toBeLessThan(250);
  });
});

describe('ensembl_get_sequence region mode type guard (issue #25)', () => {
  it.each([
    ['prefixed', { id: 'homo_sapiens:13:32315086-32320268' }, 'cdna'],
    ['prefixed', { id: 'homo_sapiens:13:32315086-32320268' }, 'protein'],
    ['bare', { id: '13:32315086-32320268', species: 'homo_sapiens' }, 'cds'],
    ['bare', { id: '13:32315086-32320268', species: 'homo_sapiens' }, 'protein'],
  ])('makes no upstream request for a %s region with type %s', async (_form, args, type) => {
    const result = await runToolContract(ensemblGetSequence, { ...args, type } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'type_mismatch' } },
    });
    expect(http.calls).toHaveLength(0);
  });
});

describe('ensembl_get_sequence windows through the service (issue #19)', () => {
  it('walks nextOffset over a real response and reconstructs it byte-for-byte', async () => {
    const full = dna(25_768, 13);
    http.route({
      match: SEQUENCE_ID,
      respond: () => Response.json({ id: 'ENSG00000141510', molecule: 'dna', seq: full }),
    });
    const pages: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await runToolContract(ensemblGetSequence, { id: 'ENSG00000141510', offset });
      const page = result.structuredContent as {
        seq: string;
        length: number;
        nextOffset?: number;
      };
      expect(page.length).toBe(25_768);
      pages.push(page.seq);
      offset = page.nextOffset;
    }
    expect(pages.map((p) => p.length)).toEqual([10_000, 10_000, 5_768]);
    expect(pages.join('')).toBe(full);
    // The window is a post-fetch slice: every page requests the whole sequence, untrimmed.
    expect(http.calls).toHaveLength(3);
    for (const call of http.calls) {
      expect(call.request.url).toBe(
        'https://rest.ensembl.org/sequence/id/ENSG00000141510?type=genomic',
      );
    }
  });

  it('indexes the window into the expanded sequence, not the requested region', async () => {
    const expanded = dna(35, 5);
    http.route({
      match: SEQUENCE_REGION,
      respond: () =>
        Response.json({ id: 'chromosome:GRCh38:13:32315076:32315110:1', seq: expanded }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: '13:32315086-32315100',
      species: 'homo_sapiens',
      expand_5prime: 10,
      expand_3prime: 10,
      offset: 30,
      max_length: 10,
    });
    expect(result.structuredContent).toMatchObject({
      seq: expanded.slice(30),
      length: 35,
      offset: 30,
      truncated: false,
    });
    expect(http.calls[0]?.request.url).toContain('expand_5prime=10&expand_3prime=10');
  });
});
