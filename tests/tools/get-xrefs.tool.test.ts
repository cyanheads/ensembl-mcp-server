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
  dbDisplayName: 'UniProtKB Gene Name',
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
  it('returns captured RefSeq child-object references only in all-levels scope', async () => {
    const http = createFetchMock();
    http.install();
    upstream.real = true;
    initEnsemblService({} as AppConfig, createInMemoryStorage());
    http.route({
      match: /^https:\/\/rest\.ensembl\.org\/xrefs\/id\//,
      respond: (request) =>
        Response.json(
          new URL(request.url).searchParams.get('all_levels') === '1'
            ? [
                {
                  dbname: 'RefSeq_mRNA',
                  db_display_name: 'RefSeq mRNA',
                  primary_id: 'NM_000059',
                  display_id: 'NM_000059.4',
                  description: null,
                },
              ]
            : [],
        ),
    });
    try {
      const direct = await runToolContract(ensemblGetXrefs, {
        id: 'ENSG00000139618',
        dbname: 'RefSeq_mRNA',
      });
      expect(direct.structuredContent).toMatchObject({ xrefs: [], totalCount: 0 });
      const all = await runToolContract(ensemblGetXrefs, {
        id: 'ENSG00000139618',
        dbname: 'RefSeq_mRNA',
        all_levels: true,
      });
      expect(all.structuredContent).toMatchObject({
        totalCount: 1,
        xrefs: [{ primaryId: 'NM_000059', displayId: 'NM_000059.4' }],
      });
      expect(all.structuredContent).not.toHaveProperty('notice');
      expect(
        all.content?.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('NM_000059.4');
    } finally {
      http.restore();
      upstream.real = false;
    }
  });
  it('characterizes default object-level scope before adding hierarchy selection', async () => {
    mockGetXrefsById.mockResolvedValueOnce([hgncXref]);
    const result = await runToolContract(ensemblGetXrefs, { id: 'ENSG00000139618' });
    expect(result.structuredContent).toMatchObject({ totalCount: 1, xrefs: [hgncXref] });
    expect(JSON.stringify(result.content)).toContain('HGNC:1101');
  });

  it.each([undefined, false, true])(
    'forwards all_levels=%s independently of dbname',
    async (all_levels) => {
      const http = createFetchMock();
      upstream.real = true;
      http.install();
      initEnsemblService({} as AppConfig, createInMemoryStorage());
      http.route({
        match: /^https:\/\/rest\.ensembl\.org\/xrefs\/id\//,
        respond: () => Response.json([]),
      });
      try {
        for (const dbname of [undefined, 'RefSeq_mRNA']) {
          const result = await runToolContract(ensemblGetXrefs, {
            id: 'ENSG00000139618',
            dbname,
            all_levels,
          } as never);
          expect(result.isError).toBeUndefined();
          const url = new URL(http.calls.at(-1)!.request.url);
          expect(url.searchParams.get('all_levels')).toBe(all_levels ? '1' : null);
          expect(url.searchParams.get('external_db')).toBe(dbname ?? null);
          expect(result.structuredContent).toMatchObject({ totalCount: 0, xrefs: [] });
          const notice = String((result.structuredContent as { notice?: string }).notice);
          expect(notice).toContain(all_levels ? 'feature ID' : 'all_levels=true');
          expect(
            result.content?.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
          ).toContain(notice);
        }
      } finally {
        http.restore();
        upstream.real = false;
      }
    },
  );
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
    expect(mockGetXrefsById).toHaveBeenCalledWith(
      'ENSG00000139618',
      'HGNC',
      expect.anything(),
      false,
    );
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
    expect(mockGetXrefsById).toHaveBeenCalledWith(
      'ENSG00000139618',
      undefined,
      expect.anything(),
      false,
    );
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

  it('renders a database with one display name under one heading', () => {
    const second: XrefEntry = { ...hgncXref, primaryId: 'HGNC:11998', displayId: 'TP53' };
    const blocks = ensemblGetXrefs.format!({
      xrefs: [hgncXref, uniprotXref, second],
      totalCount: 3,
      queriedId: 'ENSG00000139618',
    });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(
      '### HGNC Symbol (HGNC)\n- **HGNC:1101** (BRCA2): BRCA2 DNA repair associated\n' +
        '- **HGNC:11998** (TP53): BRCA2 DNA repair associated\n\n' +
        '### UniProtKB Gene Name (Uniprot_gn)\n- **P51587** (BRCA2_HUMAN)\n',
    );
    expect(text.match(/^### /gm)).toHaveLength(2);
  });

  /** Ensembl gives `dbname: "GO"` two display names, interleaved in its answer (ENST00000269305). */
  const goDirect: XrefEntry = {
    dbname: 'GO',
    dbDisplayName: 'GO',
    primaryId: 'GO:0000978',
    displayId: 'GO:0000978',
    description: 'RNA polymerase II cis-regulatory region sequence-specific DNA binding',
  };
  const goProjected: XrefEntry = {
    ...goDirect,
    dbDisplayName: 'Projected GO',
    primaryId: 'GO:0001228',
    displayId: 'GO:0001228',
    description: 'DNA-binding transcription activator activity',
  };
  const goDirect2: XrefEntry = {
    ...goDirect,
    primaryId: 'GO:0005634',
    displayId: 'GO:0005634',
    description: 'nucleus',
  };
  const goSection =
    '### GO\n- **GO:0000978**: RNA polymerase II cis-regulatory region sequence-specific DNA binding\n' +
    '- **GO:0005634**: nucleus\n';
  const projectedSection =
    '### Projected GO (GO)\n- **GO:0001228**: DNA-binding transcription activator activity\n';

  it.each([
    ['a GO row', [goDirect, goProjected, goDirect2], [goSection, projectedSection]],
    ['a Projected GO row', [goProjected, goDirect, goDirect2], [projectedSection, goSection]],
  ])(
    'heads each display name of one dbname separately when %s comes first (issue #57)',
    (_first, xrefs, sections) => {
      const blocks = ensemblGetXrefs.format!({
        xrefs,
        totalCount: 3,
        queriedId: 'ENST00000269305',
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain(`${sections[0]}\n${sections[1]}`);
      expect(text.match(/^### /gm)).toHaveLength(2);
    },
  );

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

describe('ensemblGetXrefs reference provenance (issue #59)', () => {
  const description = 'RNA polymerase II cis-regulatory region sequence-specific DNA binding';
  /** The five GO:0000978 rows /xrefs/id/ENST00000269305 returns, in Ensembl's order. */
  const rows = [
    ['Projected GO', 'PROJECTION', 'from mus_musculus translation ENSMUSP00000104298', ['IEA']],
    ['GO', 'DIRECT', 'UniProt', ['ISS']],
    ['GO', 'DIRECT', 'GO_Central', ['IBA']],
    ['GO', 'DIRECT', 'ARUK-UCL', ['IDA']],
    ['GO', 'DIRECT', 'ParkinsonsUK-UCL', ['IDA']],
  ] as const;

  it('carries infoType, infoText and linkageTypes on both surfaces', async () => {
    const http = createFetchMock([
      {
        match: (request) => new URL(request.url).hostname === 'rest.ensembl.org',
        respond: Response.json(
          rows.map(([db_display_name, info_type, info_text, linkage_types]) => ({
            dbname: 'GO',
            db_display_name,
            primary_id: 'GO:0000978',
            display_id: 'GO:0000978',
            description,
            info_type,
            info_text,
            linkage_types,
            synonyms: [],
            version: '0',
          })),
        ),
      },
    ]);
    http.install();
    upstream.real = true;
    initEnsemblService({} as AppConfig, createInMemoryStorage());
    try {
      const result = await runToolContract(ensemblGetXrefs, {
        id: 'ENST00000269305',
        dbname: 'GO',
      });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { xrefs: XrefEntry[] }).xrefs).toEqual(
        rows.map(([dbDisplayName, infoType, infoText, linkageTypes]) => ({
          dbname: 'GO',
          dbDisplayName,
          primaryId: 'GO:0000978',
          displayId: 'GO:0000978',
          description,
          infoType,
          infoText,
          linkageTypes,
        })),
      );
      const lines = (result.content ?? [])
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .split('\n');
      const expected = [
        `- **GO:0000978**: ${description} [PROJECTION; from mus_musculus translation ENSMUSP00000104298; evidence IEA]`,
        `- **GO:0000978**: ${description} [DIRECT; UniProt; evidence ISS]`,
        `- **GO:0000978**: ${description} [DIRECT; GO_Central; evidence IBA]`,
        `- **GO:0000978**: ${description} [DIRECT; ARUK-UCL; evidence IDA]`,
        `- **GO:0000978**: ${description} [DIRECT; ParkinsonsUK-UCL; evidence IDA]`,
      ];
      for (const line of expected) expect(lines).toContain(line);
      expect(lines.filter((l) => l.startsWith('- **GO:0000978**'))).toHaveLength(5);
    } finally {
      upstream.real = false;
      http.restore();
    }
  });

  it.each([
    ['infoType alone', { infoType: 'DEPENDENT' }, ' [DEPENDENT]'],
    ['infoText alone', { infoText: 'UniProt' }, ' [UniProt]'],
    ['linkageTypes alone', { linkageTypes: ['IEA'] }, ' [evidence IEA]'],
    [
      'several evidence codes',
      { linkageTypes: ['IEA', 'IDA', 'IMP'] },
      ' [evidence IEA, IDA, IMP]',
    ],
    ['none', {}, ''],
  ])('renders %s after the row', (_case, provenance, tail) => {
    const blocks = ensemblGetXrefs.format!({
      xrefs: [{ ...hgncXref, ...provenance }],
      totalCount: 1,
      queriedId: 'ENSG00000139618',
    });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text.split('\n')).toContain(
      `- **HGNC:1101** (BRCA2): BRCA2 DNA repair associated${tail}`,
    );
  });

  it('describes the provenance fields on the output schema', () => {
    const entry = ensemblGetXrefs.output.shape.xrefs.element.shape;
    expect(entry.infoType.description).toContain('PROJECTION');
    expect(entry.infoText.description).toContain('Omitted when blank');
    expect(entry.linkageTypes.description).toContain('evidence codes');
  });
});

describe('ensemblGetXrefs onward chains (issue #54)', () => {
  it('names only chains the returned databases support', () => {
    const { description } = ensemblGetXrefs;
    // No level of a gene's references carries a PubMed database.
    expect(description).not.toContain('PubMed IDs');
    expect(description).not.toMatch(/literature/i);
    expect(description).toContain(
      'a Uniprot/SWISSPROT accession to UniProt (protein function) and PubChem (bioassays against the protein)',
    );
    expect(description).toContain('MIM_GENE to OMIM (disease)');
    expect(description).toContain('Reactome_gene and Reactome to Reactome (pathways)');
    expect(description).toContain('PDB to structure sources');
  });

  it('lists Uniprot/SWISSPROT as a common dbname, held on the translation', () => {
    expect(ensemblGetXrefs.description).toContain(
      'Uniprot/SWISSPROT (reviewed UniProt accession, held on the translation',
    );
    expect(ensemblGetXrefs.input.shape.dbname.description).toContain(
      'Uniprot/SWISSPROT (reviewed UniProt accession, on the translation)',
    );
    expect(ensemblGetXrefs.output.shape.xrefs.element.shape.dbname.description).toContain(
      'Uniprot/SWISSPROT',
    );
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
    expect(mockGetXrefsById).toHaveBeenCalledWith(
      'ENSG00000139618',
      undefined,
      expect.anything(),
      false,
    );
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
