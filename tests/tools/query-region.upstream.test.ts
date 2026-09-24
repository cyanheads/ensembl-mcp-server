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
        match: ASSEMBLY,
        once: true,
        respond: () => Response.json({ error: 'Something went wrong upstream' }, { status: 500 }),
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
    [
      '1:500-100',
      'Cannot request a slice whose start is greater than its end. Start: 500. End: 100',
    ],
    ['1:1-5000000.5', 'Could not decode region 1:1-5000000.5'],
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
