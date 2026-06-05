/**
 * @fileoverview Tests for the ensembl_get_xrefs tool.
 * @module tests/tools/get-xrefs.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGetXrefs } from '@/mcp-server/tools/definitions/get-xrefs.tool.js';
import type { XrefEntry } from '@/services/ensembl/types.js';

const mockGetXrefsById = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ getXrefsById: mockGetXrefsById }),
}));

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
