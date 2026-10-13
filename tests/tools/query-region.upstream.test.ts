/**
 * @fileoverview ensembl_query_region through the real EnsemblService against a
 * strict fetch fake — the seam that includes URL building, error-envelope
 * mapping, and the assembly cache. Counts every upstream request.
 * @module tests/tools/query-region.upstream.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensemblQueryRegion } from '@/mcp-server/tools/definitions/query-region.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';

const OVERLAP = /^https:\/\/rest\.ensembl\.org\/overlap\/region\//;
const ASSEMBLY = /^https:\/\/rest\.ensembl\.org\/info\/assembly\//;

const geneRow = {
  id: 'ENSG00000244734',
  external_name: 'HBB',
  feature_type: 'gene',
  biotype: 'protein_coding',
  seq_region_name: '11',
  start: 5225464,
  end: 5229395,
  strand: -1,
  assembly_name: 'GRCh38',
};

const regulatoryRow = {
  id: 'ENSR1_C4ND',
  feature_type: 'regulatory',
  seq_region_name: '1',
  start: 999971,
  end: 1001148,
  strand: 0,
  description: 'promoter',
};

const assemblyInfo = {
  assembly_name: 'GRCh38.p14',
  default_coord_system_version: 'GRCh38',
  top_level_region: [],
};

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

const requests = (pattern: RegExp) => http.calls.filter((c) => pattern.test(c.request.url)).length;

/** Concatenated text of every `content[]` block — what a `content`-only client reads. */
const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('\n');

const invalidRegion = () => ensemblQueryRegion.errors!.find((e) => e.reason === 'invalid_region')!;

describe('ensembl_query_region upstream requests', () => {
  it('makes exactly one request when a feature row carries its assembly (issue #23)', async () => {
    http.route({ match: OVERLAP, respond: () => Response.json([geneRow]) });
    const result = await runToolContract(ensemblQueryRegion, {
      species: 'homo_sapiens',
      region: '11:5225000-5230000',
    });
    expect(result.structuredContent).toMatchObject({ assemblyName: 'GRCh38', totalCount: 1 });
    expect(http.calls).toHaveLength(1);
    expect(requests(ASSEMBLY)).toBe(0);
  });

  it('looks up the species default once per process for regulatory-only results (issue #23)', async () => {
    http.route(
      { match: OVERLAP, respond: () => Response.json([regulatoryRow]) },
      { match: ASSEMBLY, respond: () => Response.json(assemblyInfo) },
    );
    const args = { species: 'homo_sapiens', region: '1:999000-1002000', feature: ['regulatory'] };

    const first = await runToolContract(ensemblQueryRegion, args as never);
    const second = await runToolContract(ensemblQueryRegion, args as never);

    expect(first.structuredContent).toMatchObject({ assemblyName: 'GRCh38' });
    expect(second.structuredContent).toMatchObject({ assemblyName: 'GRCh38' });
    expect(requests(OVERLAP)).toBe(2);
    expect(requests(ASSEMBLY)).toBe(1);
    expect(http.calls.find((c) => ASSEMBLY.test(c.request.url))?.request.url).toBe(
      'https://rest.ensembl.org/info/assembly/homo_sapiens',
    );
  });

  it('degrades to a notice when the fallback fails, and retries the lookup next call (issue #23)', async () => {
    http.route(
      { match: OVERLAP, respond: () => Response.json([]) },
      {
        // A 400 envelope is not retried, so the first call's lookup fails outright.
        match: ASSEMBLY,
        once: true,
        respond: () => Response.json({ error: 'Something went wrong upstream' }, { status: 400 }),
      },
      { match: ASSEMBLY, respond: () => Response.json(assemblyInfo) },
    );
    const args = { species: 'homo_sapiens', region: '13:1000-2000' };

    const degraded = await runToolContract(ensemblQueryRegion, args);
    expect(degraded.isError).toBeUndefined();
    const structured = degraded.structuredContent as Record<string, unknown>;
    expect(structured.assemblyName).toBeUndefined();
    expect(structured.notice).toContain('intergenic');
    expect(structured.notice).toContain('could not be resolved');
    expect(requests(ASSEMBLY)).toBe(1);

    const recovered = await runToolContract(ensemblQueryRegion, args);
    expect(recovered.structuredContent).toMatchObject({ assemblyName: 'GRCh38' });
    expect(requests(ASSEMBLY)).toBe(2);
  });

  it('propagates a cancellation during the fallback as a failure (issue #23)', async () => {
    const controller = new AbortController();
    http.route(
      { match: OVERLAP, respond: () => Response.json([regulatoryRow]) },
      {
        match: ASSEMBLY,
        respond: () => {
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        },
      },
    );
    const result = await runToolContract(
      ensemblQueryRegion,
      { species: 'homo_sapiens', region: '1:999000-1002000', feature: ['regulatory'] },
      { context: { signal: controller.signal } },
    );
    // A failure, never a degraded success: no feature payload, no assembly-gap notice.
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.error).toBeDefined();
    expect(structured.features).toBeUndefined();
    expect(structured.notice).toBeUndefined();
  });

  it.each([
    ['1:1-5000001', 5000001],
    // A start-only region extends to the chromosome end; Ensembl reports the clipped length.
    ['13:100', 114364229],
  ])(
    'classifies the upstream length rejection for %s as invalid_region (issue #24)',
    async (region, length) => {
      http.route({
        match: OVERLAP,
        respond: () =>
          Response.json(
            {
              error: `${length} is greater than the maximum allowed length of 5000000. Request smaller regions of sequence`,
            },
            { status: 400 },
          ),
      });
      const result = await runToolContract(ensemblQueryRegion, { species: 'homo_sapiens', region });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region' } },
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each([
    [
      '1:250000000-250000100',
      'Cannot request a slice whose start (250000000) is greater than 248956422 for 1.',
    ],
    // A comma-grouped region skips the local order check; Ensembl still rejects it reversed.
    [
      '1:5,000-1,000',
      'Cannot request a slice whose start is greater than its end. Start: 5000. End: 1000',
    ],
    ['1:1-5000000.5', 'Could not decode region 1:1-5000000.5'],
    // A strand spelling the grammar does not take is forwarded, and Ensembl rejects it.
    ['13:32315086-32400268:-', '- is not a valid strand'],
  ])(
    'classifies the upstream rejection of %s as invalid_region (issue #27)',
    async (region, error) => {
      http.route({ match: OVERLAP, respond: () => Response.json({ error }, { status: 400 }) });
      const result = await runToolContract(ensemblQueryRegion, { species: 'homo_sapiens', region });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region' } },
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each([
    ['1:500-100', '500', '100'],
    ['1:500..100', '500', '100'],
    ['1:500-100:-1', '500', '100'],
    ['1:0500-0499', '500', '499'],
    [
      '1:100000000000000000001-100000000000000000000',
      '100000000000000000001',
      '100000000000000000000',
    ],
  ])(
    'rejects the reversed region %s before any request (issue #31)',
    async (region, start, end) => {
      const result = await runToolContract(ensemblQueryRegion, { species: 'homo_sapiens', region });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'invalid_region', recovery: { hint: invalidRegion().recovery } },
        },
      });
      const text = textOf(result);
      expect(text).toContain(`start ${start} is greater than its end ${end}`);
      expect(text).toContain('(reason invalid_region)');
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    '1:100-100',
    '1:100..500',
    '1:100-500:-1',
    'MT:1-100',
    'MT:16000',
    '1:1,000,000-1,001,000',
    'chrMT:1-100',
  ])('forwards %s unchanged (issue #31)', async (region) => {
    http.route({ match: OVERLAP, respond: () => Response.json([geneRow]) });
    const result = await runToolContract(ensemblQueryRegion, { species: 'homo_sapiens', region });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ region, totalCount: 1 });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.url).toBe(
      `https://rest.ensembl.org/overlap/region/homo_sapiens/${encodeURIComponent(region)}?feature=gene`,
    );
  });

  describe('species-prefixed regions (issue #42)', () => {
    const overlapUrl = (species: string, region: string) =>
      `https://rest.ensembl.org/overlap/region/${species}/${encodeURIComponent(region)}?feature=gene`;

    it.each([
      // Before the fix Ensembl read the trailing -end as a strand ("-3 is not a valid strand").
      ['homo_sapiens:13:32315086-32400268', {}, 'homo_sapiens', '13:32315086-32400268'],
      // The prefix names the organism the coordinates belong to, so it wins over species.
      [
        'homo_sapiens:13:32315086-32400268',
        { species: 'mus_musculus' },
        'homo_sapiens',
        '13:32315086-32400268',
      ],
      // Strain and alternate-assembly internal names carry digits (#33's grammar).
      [
        'mus_musculus_129s1svimj:1:3000000-3100000',
        {},
        'mus_musculus_129s1svimj',
        '1:3000000-3100000',
      ],
      ['homo_sapiens:1:100..500:-1', {}, 'homo_sapiens', '1:100..500:-1'],
    ])(
      'reads the prefix of %s as the species and forwards the region without it',
      async (region, extra, species, forwarded) => {
        http.route({ match: OVERLAP, respond: () => Response.json([geneRow]) });
        const result = await runToolContract(ensemblQueryRegion, { region, ...extra });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          species,
          region: forwarded,
          totalCount: 1,
        });
        expect(textOf(result)).toContain(`## Genomic Region: ${species} ${forwarded}`);
        expect(http.calls.map((c) => c.request.url)).toEqual([overlapUrl(species, forwarded)]);
      },
    );

    it.each([
      ['homo_sapiens:1:500-100', '500', '100'],
      ['mus_musculus_129s1svimj:1:3000020-3000000', '3000020', '3000000'],
      ['homo_sapiens:1:0500..0499:-1', '500', '499'],
    ])('rejects the reversed prefixed region %s before any request', async (region, start, end) => {
      // species set, so the exemption the unfixed code gave a prefixed region is what fails.
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region,
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'invalid_region', recovery: { hint: invalidRegion().recovery } },
        },
      });
      expect(textOf(result)).toContain(`start ${start} is greater than its end ${end}`);
      expect(http.calls).toHaveLength(0);
    });

    it('maps an unknown prefixed species to invalid_species naming the prefix', async () => {
      http.route({
        match: OVERLAP,
        respond: () =>
          Response.json(
            { error: "Can not find internal name for species 'homo_sapien'" },
            { status: 400 },
          ),
      });
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: 'homo_sapien:13:32315086-32400268',
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_species' } },
      });
      expect(textOf(result)).toContain('Species "homo_sapien" not recognized');
      expect(http.calls.map((c) => c.request.url)).toEqual([
        overlapUrl('homo_sapien', '13:32315086-32400268'),
      ]);
    });

    it('fails missing_species for a bare region with no species, before any request', async () => {
      const result = await runToolContract(ensemblQueryRegion, { region: '13:32315086-32400268' });
      const missing = ensemblQueryRegion.errors!.find((e) => e.reason === 'missing_species')!;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'missing_species', recovery: { hint: missing.recovery } },
        },
      });
      expect(textOf(result)).toContain('(reason missing_species)');
      expect(http.calls).toHaveLength(0);
    });

    it('states the prefixed form and its precedence on the region, species, and description', () => {
      const { region, species } = ensemblQueryRegion.input.shape;
      expect(region.description).toContain('species:chr:start-end');
      expect(species.description).toContain('takes precedence');
      expect(ensemblQueryRegion.description).toContain('homo_sapiens:13:32315086-32400268');
    });
  });

  describe('mitochondrion names (issue #39)', () => {
    /**
     * The synonyms of the region rest.ensembl.org resolves each M/chrM spelling to (a name
     * absent here answers "No slice found"), and each species' reference regions.
     */
    const RESOLVED: Record<string, string[]> = {
      'homo_sapiens/chrM': ['MU273394.1', 'NW_025791817.1', 'chrX_MU273394v1_fix'],
      'homo_sapiens/M': ['ML143355.1', 'NW_021160001.1', 'chr10_ML143355v1_fix'],
      'homo_sapiens/chrm': ['KZ208915.1', 'NW_019805491.1', 'chr15_KZ208915v1_fix'],
      'homo_sapiens/CHRM': ['chrM', 'J01415.2', 'NC_012920.1'],
      'drosophila_melanogaster/chrM': ['KJ947872', 'mitochondrion_genome', 'NC_024511.2', 'chrM'],
    };
    const TOP_LEVEL: Record<string, string[]> = {
      homo_sapiens: ['1', '13', 'X', 'Y', 'MT'],
    };
    const mtRow = {
      ...geneRow,
      id: 'ENSG00000198888',
      external_name: 'MT-ND1',
      seq_region_name: 'MT',
    };
    const flyMitoRow = {
      ...geneRow,
      id: 'FBgn0013680',
      external_name: 'mt:ND2',
      seq_region_name: 'mitochondrion_genome',
      assembly_name: 'BDGP6.54',
    };

    const routeEnsembl = () =>
      http.route(
        {
          match: /\/info\/assembly\/[^/]+\/[^/?]+\?synonyms=1$/,
          respond: (request) => {
            const [, , , species = '', name = ''] = new URL(request.url).pathname
              .split('/')
              .map(decodeURIComponent);
            const synonyms = RESOLVED[`${species}/${name}`];
            return synonyms
              ? Response.json({ synonyms: synonyms.map((n) => ({ dbname: 'INSDC', name: n })) })
              : Response.json({ error: `No slice found for location ${name}` }, { status: 400 });
          },
        },
        {
          match: ASSEMBLY,
          respond: (request) => {
            const species = new URL(request.url).pathname.split('/')[3] ?? '';
            return Response.json({
              ...assemblyInfo,
              top_level_region: (TOP_LEVEL[species] ?? []).map((name) => ({ name })),
            });
          },
        },
        {
          match: OVERLAP,
          respond: (request) =>
            Response.json([request.url.includes('drosophila') ? flyMitoRow : mtRow]),
        },
      );

    const urls = () => http.calls.map((c) => c.request.url.replace('https://rest.ensembl.org', ''));

    it.each([
      ['chrM:1-20', 'chrM', '(MT:1-20)'],
      ['M:1..20', 'M', '(MT:1..20)'],
      ['chrm:1-20:-1', 'chrm', '(MT:1-20:-1)'],
      ['chrM:16000', 'chrM', '(MT:16000)'],
      ['chrM', 'chrM', '(MT)'],
    ])(
      'rejects homo_sapiens %s, which Ensembl resolves to an unrelated scaffold',
      async (region, name, renamed) => {
        routeEnsembl();
        const result = await runToolContract(ensemblQueryRegion, {
          species: 'homo_sapiens',
          region,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: -32007,
            data: { reason: 'invalid_region', recovery: { hint: invalidRegion().recovery } },
          },
        });
        const text = textOf(result);
        expect(text).toContain(
          `Ensembl does not resolve ${name} to the mitochondrion for homo_sapiens`,
        );
        expect(text).toContain(renamed);
        // The alias check and the reference regions, never the overlap.
        expect(urls()).toEqual([
          `/info/assembly/homo_sapiens/${name}?synonyms=1`,
          '/info/assembly/homo_sapiens',
        ]);
      },
    );

    it.each([
      ['drosophila_melanogaster', 'chrM:1-2000', 'chrM', 'mt:ND2', 'BDGP6.54'],
      ['homo_sapiens', 'CHRM:1-2000', 'CHRM', 'MT-ND1', 'GRCh38'],
    ])(
      'forwards %s %s, which Ensembl resolves to the mitochondrion',
      async (species, region, name, gene, assembly) => {
        routeEnsembl();
        const result = await runToolContract(ensemblQueryRegion, { species, region });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          region,
          totalCount: 1,
          assemblyName: assembly,
          features: [{ name: gene }],
        });
        expect(textOf(result)).toContain(`### ${gene}`);
        expect(urls()).toEqual([
          `/info/assembly/${species}/${name}?synonyms=1`,
          `/overlap/region/${species}/${encodeURIComponent(region)}?feature=gene`,
        ]);
      },
    );

    it('checks the mitochondrion name of a prefixed region against the prefix species (issue #42)', async () => {
      routeEnsembl();
      const rejected = await runToolContract(ensemblQueryRegion, {
        region: 'homo_sapiens:chrM:1-20',
      });
      expect(rejected.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region' } },
      });
      const text = textOf(rejected);
      expect(text).toContain('Ensembl does not resolve chrM to the mitochondrion for homo_sapiens');
      expect(text).toContain('(MT:1-20)');
      expect(urls()).toEqual([
        '/info/assembly/homo_sapiens/chrM?synonyms=1',
        '/info/assembly/homo_sapiens',
      ]);

      const before = http.calls.length;
      const forwarded = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: 'drosophila_melanogaster:chrM:1-2000',
      });
      expect(forwarded.structuredContent).toMatchObject({
        species: 'drosophila_melanogaster',
        region: 'chrM:1-2000',
        features: [{ name: 'mt:ND2' }],
      });
      expect(urls().slice(before)).toEqual([
        '/info/assembly/drosophila_melanogaster/chrM?synonyms=1',
        `/overlap/region/drosophila_melanogaster/${encodeURIComponent('chrM:1-2000')}?feature=gene`,
      ]);
    });

    it('checks reversed coordinates before the mitochondrion name, with no request', async () => {
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'homo_sapiens',
        region: 'chrM:20-1',
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_region' } },
      });
      expect(textOf(result)).toContain('start 20 is greater than its end 1');
      expect(http.calls).toHaveLength(0);
    });

    it('maps an unknown species on the mitochondrion check to invalid_species', async () => {
      http.route({
        match: ASSEMBLY,
        respond: () =>
          Response.json(
            { error: "Can not find internal name for species 'not_a_species'" },
            { status: 400 },
          ),
      });
      const result = await runToolContract(ensemblQueryRegion, {
        species: 'not_a_species',
        region: 'chrM:1-20',
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason: 'invalid_species' } },
      });
      expect(http.calls).toHaveLength(1);
    });

    it('documents the coordinate order and where M and chrM are accepted on every surface', () => {
      const { when, recovery } = invalidRegion();
      expect(when).toContain('start greater than its end');
      expect(when).toContain('chrM');
      for (const surface of [recovery, ensemblQueryRegion.input.shape.region.description!]) {
        expect(surface).toContain('start at or below end');
        expect(surface).toContain('MT');
        expect(surface).toContain('MtDNA');
        expect(surface).toContain('chrM');
      }
    });
  });

  it('parses a long region in linear time before forwarding it (issue #31)', async () => {
    const unit = 'ab_1:2.c:3-4:5..6:-';
    http.route({ match: OVERLAP, respond: () => Response.json([]) });
    http.route({ match: ASSEMBLY, respond: () => Response.json(assemblyInfo) });
    const cpuMicros = async (size: number) => {
      const region = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const start = process.threadCpuUsage();
      const result = await runToolContract(ensemblQueryRegion, { species: 'homo_sapiens', region });
      const used = process.threadCpuUsage(start);
      // Unparsed, so it is forwarded as written.
      expect(result.isError).toBeUndefined();
      return used.user + used.system;
    };
    await cpuMicros(5_000); // warm-up
    const small = await cpuMicros(5_000);
    const large = await cpuMicros(320_000);
    // 64x the input: linear stays near 64x, quadratic would be ~4096x.
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(250_000);
  });

  it.each([
    [
      'feature: [] (issue #21)',
      { species: 'homo_sapiens', region: '11:5227002-5227020', feature: [] },
    ],
    ['blank region (issue #22)', { species: 'homo_sapiens', region: '  ' }],
    ['blank species (issue #22)', { species: '', region: '11:5227002-5227020' }],
  ])('makes no upstream request for %s', async (_label, args) => {
    const result = await runToolContract(ensemblQueryRegion, args as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(http.calls).toHaveLength(0);
  });
});
