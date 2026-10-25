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
import { readMarkdownText } from '../helpers/read-markdown.js';

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

/** Concatenated text of every `content[]` block — what a `content`-only client reads. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const recoveryFor = (reason: string) =>
  ensemblGetSequence.errors!.find((e) => e.reason === reason)!.recovery;

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
});

describe('ensembl_get_sequence region grammar (issues #29, #36)', () => {
  // Recorded from rest.ensembl.org: the forward 21 bp is GGTGGAGCGCGCCGCCACGGA.
  const reverseStrand = {
    id: 'chromosome:GRCh38:1:1000000:1000020:-1',
    molecule: 'dna',
    seq: 'TCCGTGGCGGCGCGCTCCACC',
    query: '1:1000000-1000020:-1',
  };

  it('returns the reverse complement for a :-1 strand suffix on both surfaces', async () => {
    http.route({ match: SEQUENCE_REGION, respond: () => Response.json(reverseStrand) });
    const result = await runToolContract(ensemblGetSequence, {
      id: '1:1000000-1000020:-1',
      species: 'homo_sapiens',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      id: 'chromosome:GRCh38:1:1000000:1000020:-1',
      type: 'genomic',
      seq: 'TCCGTGGCGGCGCGCTCCACC',
      length: 21,
    });
    const text = textOf(result);
    expect(text).toContain('chromosome:GRCh38:1:1000000:1000020:-1');
    expect(text).toContain('TCCGTGGCGGCGCGCTCCACC');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/region/homo_sapiens/1%3A1000000-1000020%3A-1',
    );
  });

  it.each([
    [
      'a .. separator',
      { id: '1:1000000..1000020', species: 'homo_sapiens' },
      'homo_sapiens',
      '1:1000000..1000020',
    ],
    [
      'an explicit :1 strand',
      { id: '1:1000000-1000020:1', species: 'homo_sapiens' },
      'homo_sapiens',
      '1:1000000-1000020:1',
    ],
    [
      'a prefixed :-1 strand',
      { id: 'homo_sapiens:1:1000000-1000020:-1' },
      'homo_sapiens',
      '1:1000000-1000020:-1',
    ],
    [
      'an upper-case prefixed .. strand form',
      { id: 'HOMO_SAPIENS:chr1:1000000..1000020:-1' },
      'HOMO_SAPIENS',
      'chr1:1000000..1000020:-1',
    ],
  ])('routes %s to the region endpoint unchanged', async (_label, args, species, region) => {
    http.route({ match: SEQUENCE_REGION, respond: () => Response.json(reverseStrand) });
    const result = await runToolContract(ensemblGetSequence, args);
    expect(result.isError).toBeUndefined();
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      `https://rest.ensembl.org/sequence/region/${species}/${encodeURIComponent(region)}`,
    );
  });

  it.each([
    ['a reversed :-1 region', { id: '1:500-100:-1', species: 'homo_sapiens' }, '500', '100'],
    ['a reversed .. region', { id: '1:500..100', species: 'homo_sapiens' }, '500', '100'],
    ['a reversed prefixed strand region', { id: 'homo_sapiens:1:500..100:1' }, '500', '100'],
  ])(
    'rejects %s locally, reading start and end from the parse',
    async (_label, args, start, end) => {
      const result = await runToolContract(ensemblGetSequence, args);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'invalid_region', recovery: { hint: recoveryFor('invalid_region') } },
        },
      });
      expect(textOf(result)).toContain(`start ${start} is greater than its end ${end}`);
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    '1:1-5000000.5',
    '1:1,000-2,000',
    'MT:100',
    '1:100-200:+1',
    '1:100-200:0',
    '1:-100',
    ':1-100',
    '1:100_200',
    'homo_sapiens:1:2:100-200',
    'homo-sapiens:1:100-200',
  ])(
    'rejects the colon id %j as invalid_region naming the accepted form, with no request',
    async (id) => {
      const result = await runToolContract(ensemblGetSequence, { id, species: 'homo_sapiens' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'invalid_region', recovery: { hint: recoveryFor('invalid_region') } },
        },
      });
      const text = textOf(result);
      expect(readMarkdownText(text)).toContain('[species:]chr:start-end');
      expect(text).toContain('(reason invalid_region)');
      expect(http.calls).toHaveLength(0);
    },
  );

  it('parses a long malformed colon id in linear time, with no request', async () => {
    const unit = 'ab_1:2.c:3-4:5..6:-';
    const cpuMicros = async (size: number) => {
      const id = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const start = process.threadCpuUsage();
      const result = await runToolContract(ensemblGetSequence, { id, species: 'homo_sapiens' });
      const used = process.threadCpuUsage(start);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_region' } },
      });
      return used.user + used.system;
    };
    await cpuMicros(5_000); // warm-up
    const small = await cpuMicros(5_000);
    const large = await cpuMicros(320_000);
    // 64x the input: linear stays near 64x, quadratic would be ~4096x.
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(250_000);
    expect(http.calls).toHaveLength(0);
  });
});

describe('ensembl_get_sequence species and type rejections (issue #29)', () => {
  const unknownSpecies = () =>
    Response.json(
      { error: "Can not find internal name for species 'homo_sapienz'" },
      { status: 400 },
    );

  it.each([
    ['bare', { id: '1:1-100', species: 'homo_sapienz' }],
    ['prefixed', { id: 'homo_sapienz:1:1-100' }],
  ])('classifies an unknown species on a %s region as invalid_species', async (_form, args) => {
    http.route({ match: SEQUENCE_REGION, respond: unknownSpecies });
    const result = await runToolContract(ensemblGetSequence, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'invalid_species', recovery: { hint: recoveryFor('invalid_species') } },
      },
    });
    expect(recoveryFor('invalid_species')).toContain('ensembl_list_species');
    const text = textOf(result);
    expect(text).toContain('homo_sapienz');
    expect(text).toContain('(reason invalid_species)');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/region/homo_sapienz/1%3A1-100',
    );
  });

  it('classifies cds from a non-coding transcript as type_mismatch about a transcript', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () =>
        Response.json(
          {
            error:
              'No sequences returned, please check the type specified is compatible with the object requested',
          },
          { status: 400 },
        ),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENST00000456328',
      type: 'cds',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'type_mismatch', recovery: { hint: recoveryFor('type_mismatch') } },
      },
    });
    const text = textOf(result);
    expect(text).toContain('no cds sequence for ENST00000456328');
    expect(text).toContain('non-coding transcript');
    expect(text).not.toContain('from a gene ID');
    expect(recoveryFor('type_mismatch')).toContain('non-coding transcript has no protein or CDS');
    expect(http.calls).toHaveLength(1);
  });

  it('classifies long echoed rejections in linear time on both paths', async () => {
    const unit = 'no sequences returne can not find internal name for specie not foun ';
    const cpuMicros = async (size: number) => {
      const error = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      http.route(
        {
          match: SEQUENCE_ID,
          once: true,
          respond: () => Response.json({ error }, { status: 400 }),
        },
        {
          match: SEQUENCE_REGION,
          once: true,
          respond: () => Response.json({ error }, { status: 400 }),
        },
      );
      const start = process.threadCpuUsage();
      const byId = await runToolContract(ensemblGetSequence, { id: 'ENST00000456328' });
      const byRegion = await runToolContract(ensemblGetSequence, {
        id: '1:1-100',
        species: 'homo_sapiens',
      });
      const used = process.threadCpuUsage(start);
      // Unrecognized: a ValidationError with no declared reason on either path.
      expect(byId.structuredContent).toMatchObject({ error: { code: -32007 } });
      expect(byRegion.structuredContent).toMatchObject({ error: { code: -32007 } });
      return used.user + used.system;
    };
    await cpuMicros(5_000); // warm-up
    const small = await cpuMicros(5_000);
    const large = await cpuMicros(320_000);
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(250_000);
  });
});

describe('ensembl_get_sequence protein molecule check (issue #30)', () => {
  // Recorded from rest.ensembl.org: /sequence/id answers every type with the protein.
  const brca2Protein = {
    id: 'ENSP00000369497',
    molecule: 'protein',
    seq: 'MPIGSKERPTFFEIFKTRCNKADLGPISLNWFEELSSEAPPYNSEPAEESEHKNNNYEPN',
    version: 3,
    desc: null,
    query: 'ENSP00000369497',
  };

  it('fails a protein ID requested as the default genomic type with type_mismatch after the request', async () => {
    http.route({ match: SEQUENCE_ID, respond: () => Response.json(brca2Protein) });
    const result = await runToolContract(ensemblGetSequence, { id: 'ENSP00000369497' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'type_mismatch', recovery: { hint: recoveryFor('type_mismatch') } },
      },
    });
    const text = textOf(result);
    expect(text).toContain('ENSP00000369497 is a protein ID');
    expect(text).not.toContain('MPIGSKERPT');
    expect(recoveryFor('type_mismatch')).toContain('a protein ID serves only its protein');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/id/ENSP00000369497?type=genomic',
    );
  });

  it('serves a protein ID requested as protein unchanged', async () => {
    http.route({ match: SEQUENCE_ID, respond: () => Response.json(brca2Protein) });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENSP00000369497',
      type: 'protein',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      id: 'ENSP00000369497',
      type: 'protein',
      seq: brca2Protein.seq,
    });
    expect(result.structuredContent).not.toHaveProperty('molecule');
  });

  it('serves a transcript ID requested as cds unchanged', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () =>
        Response.json({ id: 'ENST00000380152', molecule: 'dna', seq: 'AGAGGCGGAGCCGCTGTGG' }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENST00000380152',
      type: 'cds',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ type: 'cds', seq: 'AGAGGCGGAGCCGCTGTGG' });
    expect(result.structuredContent).not.toHaveProperty('molecule');
  });
});

describe('ensembl_get_sequence species-prefixed regions (issue #33)', () => {
  // Recorded from rest.ensembl.org /sequence/region/mus_musculus_129s1svimj/1:3000000-3000020.
  const strainRow = {
    id: 'primary_assembly:129S1_SvImJ_v3:1:3000000:3000020:1',
    molecule: 'dna',
    seq: 'CCAGGAACCTGTGTCCTTTTA',
    query: '1:3000000-3000020',
  };

  it('routes a digit-bearing species prefix to region mode', async () => {
    http.route({ match: SEQUENCE_REGION, respond: () => Response.json(strainRow) });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'mus_musculus_129s1svimj:1:3000000-3000020',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      id: 'primary_assembly:129S1_SvImJ_v3:1:3000000:3000020:1',
      seq: 'CCAGGAACCTGTGTCCTTTTA',
      length: 21,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/region/mus_musculus_129s1svimj/1%3A3000000-3000020',
    );
  });

  it('lets the id species prefix win over the species field', async () => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () =>
        Response.json({
          id: 'chromosome:GRCm39:1:3000000:3000020:1',
          molecule: 'dna',
          seq: 'NNNNNNNNNNNNNNNNNNNNN',
        }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'mus_musculus:1:3000000-3000020',
      species: 'homo_sapiens',
    });
    expect(result.structuredContent).toMatchObject({ id: 'chromosome:GRCm39:1:3000000:3000020:1' });
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/region/mus_musculus/1%3A3000000-3000020',
    );
  });
});

describe('ensembl_get_sequence versioned stable IDs (issue #41)', () => {
  /** Mirrors Ensembl: /sequence/id answers a versioned stable ID with HTTP 400 not found. */
  const routeSequenceId = () =>
    http.route({
      match: SEQUENCE_ID,
      respond: (request) => {
        const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
        return /^ENS\w*\.\d+$/i.test(id)
          ? Response.json({ error: `ID '${id}' not found` }, { status: 400 })
          : Response.json({ id, molecule: 'dna', seq: 'ATGCCTATTGGATCC' });
      },
    });

  it('fetches a versioned stable ID unversioned', async () => {
    routeSequenceId();
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENST00000380152.8',
      type: 'cdna',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ id: 'ENST00000380152', type: 'cdna' });
    expect(textOf(result)).toContain('## Sequence: ENST00000380152');
    expect(http.calls.map((c) => c.request.url)).toEqual([
      'https://rest.ensembl.org/sequence/id/ENST00000380152?type=cdna',
    ]);
  });

  it('forwards a non-ENS ID with its dotted suffix unchanged', async () => {
    routeSequenceId();
    await runToolContract(ensemblGetSequence, { id: 'AT3G52430.1', type: 'cdna' });
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/id/AT3G52430.1?type=cdna',
    );
  });

  it('reads a colon id as a region and forwards its dotted chromosome unchanged', async () => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () => Response.json({ error: 'No slice found for location' }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENST00000380152.8:1-20',
      species: 'homo_sapiens',
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_region' } },
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([
      'https://rest.ensembl.org/sequence/region/homo_sapiens/ENST00000380152.8%3A1-20',
    ]);
  });

  it('keeps not_found for a versioned ID Ensembl does not hold, echoing it as submitted', async () => {
    http.route({
      match: SEQUENCE_ID,
      respond: () => Response.json({ error: "ID 'ENST99999999999' not found" }, { status: 400 }),
    });
    const result = await runToolContract(ensemblGetSequence, { id: 'ENST99999999999.2' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'not_found', recovery: { hint: recoveryFor('not_found') } },
      },
    });
    expect(textOf(result)).toContain('ID ENST99999999999.2 not found in Ensembl.');
    expect(http.calls[0]?.request.url).toBe(
      'https://rest.ensembl.org/sequence/id/ENST99999999999?type=genomic',
    );
  });

  it('states the version handling in the id description and the not_found recovery', () => {
    expect(ensemblGetSequence.input.shape.id.description).toContain('version suffix');
    expect(recoveryFor('not_found')).toContain('version suffix');
  });
});

describe('ensembl_get_sequence mitochondrion names (issue #39)', () => {
  const ASSEMBLY = /^https:\/\/rest\.ensembl\.org\/info\/assembly\//;

  /**
   * The synonyms of the region rest.ensembl.org resolves each M/chrM spelling to (a name
   * absent here answers "No slice found"), and each species' reference regions.
   */
  const RESOLVED: Record<string, string[]> = {
    'homo_sapiens/chrM': ['MU273394.1', 'NW_025791817.1', 'chrX_MU273394v1_fix'],
    'homo_sapiens/m': ['KZ208915.1', 'NW_019805491.1', 'chr15_KZ208915v1_fix'],
    'homo_sapiens/CHRM': ['chrM', 'J01415.2', 'NC_012920.1'],
    'drosophila_melanogaster/chrM': ['KJ947872', 'mitochondrion_genome', 'NC_024511.2', 'chrM'],
    // The same region with chrM left out, so mitochondrion_genome is the only synonym naming it.
    'drosophila_melanogaster/M': ['KJ947872', 'mitochondrion_genome', 'NC_024511.2'],
    'apis_mellifera/M': ['NC_001566', 'MT', 'CM009947.2', 'NC_001566.1'],
    'caenorhabditis_elegans/chrM': ['M01F1'],
    'plasmodium_falciparum/chrM': ['MAL1', 'Pf3D7_01'],
  };
  const TOP_LEVEL: Record<string, string[]> = {
    homo_sapiens: ['1', '13', 'X', 'Y', 'MT', 'KI270757.1'],
    caenorhabditis_elegans: ['I', 'II', 'III', 'IV', 'V', 'X', 'MtDNA'],
    plasmodium_falciparum: ['Pf3D7_01_v3', 'Pf3D7_API_v3', 'Pf3D7_MIT_v3'],
  };

  const routeEnsembl = () =>
    http.route(
      {
        match: ASSEMBLY,
        respond: (request) => {
          const [, , , species = '', name] = new URL(request.url).pathname
            .split('/')
            .map(decodeURIComponent);
          if (species === 'not_a_species') {
            return Response.json(
              { error: `Can not find internal name for species '${species}'` },
              { status: 400 },
            );
          }
          if (name === undefined) {
            return Response.json({
              default_coord_system_version: 'X',
              top_level_region: (TOP_LEVEL[species] ?? []).map((n) => ({ name: n })),
            });
          }
          const synonyms = RESOLVED[`${species}/${name}`];
          return synonyms
            ? Response.json({ synonyms: synonyms.map((n) => ({ dbname: 'INSDC', name: n })) })
            : Response.json({ error: `No slice found for location ${name}` }, { status: 400 });
        },
      },
      {
        match: SEQUENCE_REGION,
        respond: () =>
          Response.json({
            id: 'primary_assembly:BDGP6.54:mitochondrion_genome:1:20:1',
            molecule: 'dna',
            seq: 'AATGAATTGCCTGATAAAAA',
          }),
      },
    );

  const urls = () => http.calls.map((c) => c.request.url.replace('https://rest.ensembl.org', ''));

  it.each([
    [{ id: 'chrM:1-20', species: 'homo_sapiens' }, 'chrM', '(MT:1-20)'],
    [{ id: 'm:1-20:-1', species: 'homo_sapiens' }, 'm', '(MT:1-20:-1)'],
    [{ id: 'homo_sapiens:chrM:1..20' }, 'chrM', '(MT:1..20)'],
  ])(
    'rejects %j, which Ensembl resolves to an unrelated scaffold, naming MT',
    async (args, name, renamed) => {
      routeEnsembl();
      const result = await runToolContract(ensemblGetSequence, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'invalid_region', recovery: { hint: recoveryFor('invalid_region') } },
        },
      });
      const text = textOf(result);
      expect(text).toContain(
        `Ensembl does not resolve ${name} to the mitochondrion for homo_sapiens`,
      );
      // The region renamed to the species' mitochondrion, separator and strand kept.
      expect(text).toContain(renamed);
      expect(text).toContain('(reason invalid_region)');
      // The alias check and the reference regions, never the sequence.
      expect(urls()).toEqual([
        `/info/assembly/homo_sapiens/${name}?synonyms=1`,
        '/info/assembly/homo_sapiens',
      ]);
    },
  );

  it('rejects chrM for caenorhabditis_elegans, naming its mitochondrion MtDNA', async () => {
    routeEnsembl();
    const result = await runToolContract(ensemblGetSequence, {
      id: 'chrM:1-20',
      species: 'caenorhabditis_elegans',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'invalid_region' } },
    });
    expect(textOf(result)).toContain('(MtDNA:1-20)');
    expect(http.calls).toHaveLength(2);
  });

  it('rejects chrM where no reference region is recognizably the mitochondrion', async () => {
    routeEnsembl();
    const result = await runToolContract(ensemblGetSequence, {
      id: 'chrM:1-20',
      species: 'plasmodium_falciparum',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'invalid_region' } },
    });
    const text = textOf(result);
    expect(text).toContain(
      'Ensembl does not resolve chrM to the mitochondrion for plasmodium_falciparum',
    );
    expect(text).toContain('MtDNA');
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    ['drosophila_melanogaster', 'chrM'],
    ['drosophila_melanogaster', 'M'],
    ['apis_mellifera', 'M'],
    ['homo_sapiens', 'CHRM'],
  ])('forwards %s %s, which Ensembl resolves to the mitochondrion', async (species, name) => {
    routeEnsembl();
    const id = `${name}:1-20`;
    const result = await runToolContract(ensemblGetSequence, { id, species });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ seq: 'AATGAATTGCCTGATAAAAA', length: 20 });
    expect(textOf(result)).toContain('AATGAATTGCCTGATAAAAA');
    expect(urls()).toEqual([
      `/info/assembly/${species}/${name}?synonyms=1`,
      `/sequence/region/${species}/${encodeURIComponent(id)}`,
    ]);
  });

  it('asks Ensembl about a spelling once per species', async () => {
    routeEnsembl();
    for (const species of ['homo_sapiens', 'drosophila_melanogaster', 'homo_sapiens']) {
      await runToolContract(ensemblGetSequence, { id: 'chrM:1-20', species });
    }
    await runToolContract(ensemblGetSequence, { id: 'drosophila_melanogaster:chrM:5-9' });
    expect(urls()).toEqual([
      '/info/assembly/homo_sapiens/chrM?synonyms=1',
      '/info/assembly/homo_sapiens',
      '/info/assembly/drosophila_melanogaster/chrM?synonyms=1',
      `/sequence/region/drosophila_melanogaster/${encodeURIComponent('chrM:1-20')}`,
      `/sequence/region/drosophila_melanogaster/${encodeURIComponent('chrM:5-9')}`,
    ]);
  });

  it('checks for a missing species before the mitochondrion name, with no request', async () => {
    const result = await runToolContract(ensemblGetSequence, { id: 'chrM:1-20' });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'missing_species' } },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('checks for reversed coordinates before the mitochondrion name, with no request', async () => {
    const result = await runToolContract(ensemblGetSequence, {
      id: 'chrM:20-1',
      species: 'homo_sapiens',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason: 'invalid_region' } },
    });
    expect(textOf(result)).toContain('start 20 is greater than its end 1');
    expect(http.calls).toHaveLength(0);
  });

  it('maps an unknown species on the mitochondrion check to invalid_species', async () => {
    routeEnsembl();
    const result = await runToolContract(ensemblGetSequence, {
      id: 'chrM:1-20',
      species: 'not_a_species',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'invalid_species', recovery: { hint: recoveryFor('invalid_species') } },
      },
    });
    expect(textOf(result)).toContain('Species "not_a_species" not recognized by Ensembl.');
    expect(http.calls).toHaveLength(1);
  });

  it('describes where M and chrM are accepted on every surface', () => {
    for (const surface of [
      recoveryFor('invalid_region'),
      ensemblGetSequence.input.shape.id.description!,
    ]) {
      expect(surface).toContain('MT');
      expect(surface).toContain('MtDNA');
      expect(surface).toContain('chrM');
    }
  });

  it.each(['MT:1-20', 'chrMT:1-20'])('forwards %s unchanged', async (id) => {
    http.route({
      match: SEQUENCE_REGION,
      respond: () =>
        Response.json({
          id: 'chromosome:GRCh38:MT:1:20:1',
          molecule: 'dna',
          seq: 'GATCACAGGTCTATCACCCT',
        }),
    });
    const result = await runToolContract(ensemblGetSequence, { id, species: 'homo_sapiens' });
    expect(result.structuredContent).toMatchObject({ seq: 'GATCACAGGTCTATCACCCT' });
    expect(http.calls[0]?.request.url).toBe(
      `https://rest.ensembl.org/sequence/region/homo_sapiens/${encodeURIComponent(id)}`,
    );
  });
});

describe('ensembl_get_sequence invalid_region (issue #28)', () => {
  const recovery = () => recoveryFor('invalid_region');

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
    const text = textOf(result);
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
    const text = textOf(result);
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
    // An unrecognized 400 envelope is a ValidationError that passes through without a declared reason.
    expect(result.structuredContent).toMatchObject({ error: { code: -32007 } });
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
