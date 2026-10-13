/**
 * @fileoverview Tests for the ensembl_get_xrefs tool.
 * @module tests/tools/get-xrefs.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGetXrefs } from '@/mcp-server/tools/definitions/get-xrefs.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { XrefEntry } from '@/services/ensembl/types.js';

const mockGetXrefsById = vi.fn();

/** When `real` is set, the tool runs against the real EnsemblService over a fetch fake. */
const upstream = vi.hoisted(() => ({ real: false }));

vi.mock('@/services/ensembl/ensembl-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ensembl/ensembl-service.js')>();
  return {
    ...actual,
    getEnsemblService: () =>
      upstream.real ? actual.getEnsemblService() : { getXrefsById: mockGetXrefsById },
  };
});

const hgncXref: XrefEntry = {
  dbname: 'HGNC',
  dbDisplayName: 'HGNC Symbol',
  primaryId: 'HGNC:1101',
  displayId: 'BRCA2',
  description: 'BRCA2 DNA repair associated',
};

const uniprotXref: XrefEntry = {
  dbname: 'Uniprot_gn',
  dbDisplayName: 'UniProtKB/Swiss-Prot',
  primaryId: 'P51587',
  displayId: 'BRCA2_HUMAN',
};

const entrezXref: XrefEntry = {
  dbname: 'EntrezGene',
  dbDisplayName: 'EntrezGene',
  primaryId: '675',
  displayId: '675',
};

describe('ensemblGetXrefs', () => {
  it('returns all cross-references for a stable ID', async () => {
    mockGetXrefsById.mockResolvedValueOnce([hgncXref, uniprotXref, entrezXref]);
    const ctx = createMockContext({ errors: ensemblGetXrefs.errors });
    const input = ensemblGetXrefs.input.parse({ id: 'ENSG00000139618' });
    const result = await ensemblGetXrefs.handler(input, ctx);
    expect(result.xrefs).toHaveLength(3);
    expect(result.totalCount).toBe(3);
    expect(result.queriedId).toBe('ENSG00000139618');
  });

  it('passes dbname filter to service when specified', async () => {
    mockGetXrefsById.mockResolvedValueOnce([hgncXref]);
    const ctx = createMockContext({ errors: ensemblGetXrefs.errors });
    const input = ensemblGetXrefs.input.parse({ id: 'ENSG00000139618', dbname: 'HGNC' });
    const result = await ensemblGetXrefs.handler(input, ctx);
    expect(mockGetXrefsById).toHaveBeenCalledWith('ENSG00000139618', 'HGNC', expect.anything());
    expect(result.xrefs).toHaveLength(1);
    expect(result.xrefs[0]!.dbname).toBe('HGNC');
  });

  it('throws not_found when ID does not exist', async () => {
    mockGetXrefsById.mockRejectedValueOnce(new Error('ID ENSG99999999999 not found in Ensembl'));
    const ctx = createMockContext({ errors: ensemblGetXrefs.errors });
    const input = ensemblGetXrefs.input.parse({ id: 'ENSG99999999999' });
    await expect(ensemblGetXrefs.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('surfaces the declared recovery hint on a not_found error (issue #16)', async () => {
    mockGetXrefsById.mockRejectedValueOnce(new Error('ID ENSG99999999999 not found in Ensembl'));
    const result = await runToolContract(ensemblGetXrefs, { id: 'ENSG99999999999' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'not_found',
          recovery: {
            hint: ensemblGetXrefs.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
        },
      },
    });
  });

  it('returns empty list and total 0 when no cross-references are found', async () => {
    mockGetXrefsById.mockResolvedValueOnce([]);
    const ctx = createMockContext({ errors: ensemblGetXrefs.errors });
    const input = ensemblGetXrefs.input.parse({ id: 'ENSG00000139618', dbname: 'NonExistentDB' });
    const result = await ensemblGetXrefs.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.xrefs).toHaveLength(0);
  });

  it('trims whitespace-only dbname to undefined (not passed to service)', async () => {
    mockGetXrefsById.mockResolvedValueOnce([hgncXref]);
    const ctx = createMockContext({ errors: ensemblGetXrefs.errors });
    const input = ensemblGetXrefs.input.parse({ id: 'ENSG00000139618', dbname: '   ' });
    await ensemblGetXrefs.handler(input, ctx);
    expect(mockGetXrefsById).toHaveBeenCalledWith('ENSG00000139618', undefined, expect.anything());
  });

  it('formats xrefs grouped by database', () => {
    const output = {
      xrefs: [hgncXref, uniprotXref, entrezXref],
      totalCount: 3,
      queriedId: 'ENSG00000139618',
    };
    const blocks = ensemblGetXrefs.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('HGNC');
    expect(text).toContain('HGNC:1101');
    expect(text).toContain('BRCA2');
    expect(text).toContain('P51587');
    expect(text).toContain('UniProtKB');
    expect(text).toContain('675');
  });

  it('formats empty xref list without crash', () => {
    const output = { xrefs: [], totalCount: 0, queriedId: 'ENSG00000139618' };
    const blocks = ensemblGetXrefs.format!(output);
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('No cross-references found');
  });

  it('formats sparse xref entry (no optional fields) without crash', () => {
    const sparseXref: XrefEntry = {};
    const output = { xrefs: [sparseXref], totalCount: 1, queriedId: 'ENSG00000139618' };
    const blocks = ensemblGetXrefs.format!(output);
    expect(blocks[0]!.type).toBe('text');
  });
});

describe('ensemblGetXrefs blank identifiers (issue #22)', () => {
  it.each(['', ' \t '])('rejects id %j as invalid_arguments before any request', async (id) => {
    mockGetXrefsById.mockClear();
    const result = await runToolContract(ensemblGetXrefs, { id });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(mockGetXrefsById).not.toHaveBeenCalled();
  });

  it('still accepts a blank optional dbname and sends no filter', async () => {
    mockGetXrefsById.mockClear();
    mockGetXrefsById.mockResolvedValueOnce([hgncXref]);
    const result = await runToolContract(ensemblGetXrefs, { id: 'ENSG00000139618', dbname: '' });
    expect(result.isError).toBeUndefined();
    expect(mockGetXrefsById).toHaveBeenCalledWith('ENSG00000139618', undefined, expect.anything());
  });
});

describe('ensemblGetXrefs versioned stable IDs (issue #41)', () => {
  /** Mirrors Ensembl: /xrefs/id answers a versioned stable ID with HTTP 400 not found. */
  const routeXrefs = (http: FetchMockHarness) =>
    http.route({
      match: /^https:\/\/rest\.ensembl\.org\/xrefs\/id\//,
      respond: (request) => {
        const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
        return /^ENS\w*\.\d+$/i.test(id)
          ? Response.json({ error: `ID '${id}' not found` }, { status: 400 })
          : Response.json([
              { dbname: 'HGNC', db_display_name: 'HGNC Symbol', primary_id: 'HGNC:1101' },
            ]);
      },
    });

  async function withUpstream(run: (http: FetchMockHarness) => Promise<void>) {
    const http = createFetchMock();
    http.install();
    upstream.real = true;
    initEnsemblService({} as AppConfig, createInMemoryStorage());
    try {
      routeXrefs(http);
      await run(http);
    } finally {
      upstream.real = false;
      http.restore();
    }
  }

  it('resolves a versioned ID, querying it unversioned and echoing it as submitted', async () => {
    await withUpstream(async (http) => {
      const result = await runToolContract(ensemblGetXrefs, {
        id: 'ENSG00000139618.17',
        dbname: 'HGNC',
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        queriedId: 'ENSG00000139618.17',
        totalCount: 1,
        xrefs: [{ dbname: 'HGNC', primaryId: 'HGNC:1101' }],
      });
      const text = (result.content ?? []).map((b) => (b as { text?: string }).text).join('\n');
      expect(text).toContain('## Cross-References for ENSG00000139618.17');
      expect(text).toContain('HGNC:1101');
      expect(http.calls.map((c) => c.request.url)).toEqual([
        'https://rest.ensembl.org/xrefs/id/ENSG00000139618?external_db=HGNC',
      ]);
    });
  });

  it('forwards a non-ENS ID with its dotted suffix unchanged', async () => {
    await withUpstream(async (http) => {
      await runToolContract(ensemblGetXrefs, { id: 'AT3G52430.1' });
      expect(http.calls[0]?.request.url).toBe('https://rest.ensembl.org/xrefs/id/AT3G52430.1');
    });
  });

  it('describes the version handling on id and in the not_found recovery', () => {
    expect(ensemblGetXrefs.input.shape.id.description).toContain('version suffix');
    const recovery = ensemblGetXrefs.errors!.find((e) => e.reason === 'not_found')!.recovery;
    expect(recovery).toContain('version suffix is already dropped');
  });
});
