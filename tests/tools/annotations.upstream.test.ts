/**
 * @fileoverview Annotation preservation through real Ensembl service and tool contracts.
 * @module tests/tools/annotations.upstream.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensemblGeneResource } from '@/mcp-server/resources/definitions/gene.resource.js';
import { ensemblLookupGene } from '@/mcp-server/tools/definitions/lookup-gene.tool.js';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import { initEnsemblService } from '@/services/ensembl/ensembl-service.js';
import { readMarkdownText } from '../helpers/read-markdown.js';

let http: FetchMockHarness;
beforeEach(() => {
  http = createFetchMock();
  http.install();
  initEnsemblService({} as AppConfig, createInMemoryStorage());
});
afterEach(() => http.restore());

describe('annotation characterization', () => {
  it('preserves sparse consequences and truthful nested caps', async () => {
    http.route({
      match: () => true,
      respond: () =>
        Response.json([
          {
            transcript_consequences: [{ transcript_id: 'one' }, { transcript_id: 'two' }],
            colocated_variants: [{ id: 'rs334', pubmed: [1, 2, 3] }],
          },
        ]),
    });
    const result = await runToolContract(ensemblPredictVariant, {
      variant: 'rs334',
      max_transcript_consequences: 1,
      max_pubmed_ids_per_variant: 1,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          transcriptConsequences: [{ transcriptId: 'one', consequenceTerms: [] }],
          transcriptConsequencesTotal: 2,
          colocatedVariants: [{ pubmed: [1], pubmedTotal: 3 }],
        },
      ],
    });
    expect(JSON.stringify(result.content)).toContain('1 of 2');
    expect(JSON.stringify(result.content)).toContain('1 of 3');
  });
});

/** Selected fields from the rs334 VEP response; repeated rows represent distinct alleles. */
const vep = [
  {
    input: 'rs334',
    allele_string: 'T/A/C/G',
    transcript_consequences: [
      {
        transcript_id: 'ENST00000335295',
        variant_allele: 'A',
        consequence_terms: ['missense_variant'],
        sift_prediction: 'deleterious_low_confidence',
        sift_score: 0,
        polyphen_prediction: 'benign',
        polyphen_score: 0,
        canonical: 1,
        mane_select: 'NM_000518.5',
        hgvsc: 'ENST00000335295.4:c.20A>T',
      },
      {
        transcript_id: 'ENST00000335295',
        variant_allele: 'C',
        consequence_terms: ['missense_variant'],
      },
      {
        transcript_id: 'ENST00000335295',
        variant_allele: 'G',
        consequence_terms: ['missense_variant'],
      },
    ],
    colocated_variants: [
      {
        id: 'rs334',
        allele_string: 'T/A/C/G',
        clin_sig: ['pathogenic', 'other', 'protective', 'not_provided', 'likely_benign'],
        clin_sig_ref_allele: 'T',
        clin_sig_allele: 'A:other;A:pathogenic;G:other;A:protective;A:not_provided;G:likely_benign',
      },
    ],
  },
];

describe('VEP annotation preservation', () => {
  it.each(['rs334', 'ENST00000366667.6:c.776T>C', '11:5227002:5227002:1/A'])(
    'retains annotations and requests options for %s',
    async (variant) => {
      http.route({ match: () => true, respond: () => Response.json(vep) });
      const result = await runToolContract(ensemblPredictVariant, {
        variant,
        max_transcript_consequences: 0,
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            alleleString: 'T/A/C/G',
            transcriptConsequences: [
              {
                variantAllele: 'A',
                canonical: true,
                maneSelect: 'NM_000518.5',
                sift: { prediction: 'deleterious_low_confidence', score: 0 },
                polyphen: { prediction: 'benign', score: 0 },
                hgvsc: 'ENST00000335295.4:c.20A>T',
              },
              { variantAllele: 'C' },
              { variantAllele: 'G' },
            ],
            colocatedVariants: [
              {
                clinicalSignificance: vep[0]!.colocated_variants[0]!.clin_sig,
                clinicalSignificanceReferenceAllele: 'T',
                clinicalSignificanceByAllele: {
                  A: ['other', 'pathogenic', 'protective', 'not_provided'],
                  G: ['other', 'likely_benign'],
                },
              },
            ],
          },
        ],
      });
      const text = JSON.stringify(result.content);
      for (const value of [
        'T/A/C/G',
        'NM_000518.5',
        '**SIFT:** deleterious_low_confidence (score: 0)',
        '**PolyPhen:** benign (score: 0)',
        '**Ensembl canonical:** true',
        '**HGVSc:** ENST00000335295.4:c.20A>T',
        'aggregate clinical significance: pathogenic, other, protective, not_provided, likely_benign',
        'Clinical reference allele: T',
        'A: other, pathogenic',
        'G: other, likely_benign',
      ])
        expect(text).toContain(value);
      const query = new URL(http.calls[0]!.request.url).searchParams;
      expect(Object.fromEntries(query)).toEqual({ hgvs: '1', canonical: '1', mane: '1' });
      const structured = result.structuredContent as {
        results: {
          transcriptConsequences: object[];
          colocatedVariants: { clinicalSignificanceByAllele: object }[];
        }[];
      };
      expect(structured.results[0]!.transcriptConsequences[1]).not.toHaveProperty('canonical');
      expect(
        structured.results[0]!.colocatedVariants[0]!.clinicalSignificanceByAllele,
      ).not.toHaveProperty('C');
    },
  );
  it.each([undefined, '', 'missing;A:;:pathogenic;A:other:extra'])(
    'omits unavailable or malformed clinical attribution %j',
    async (annotation) => {
      http.route({
        match: () => true,
        respond: () =>
          Response.json([
            {
              transcript_consequences: [{ sift_score: 0, polyphen_prediction: 'benign' }],
              colocated_variants: [
                {
                  clin_sig: ['pathogenic'],
                  ...(annotation !== undefined && { clin_sig_allele: annotation }),
                },
              ],
            },
          ]),
      });
      const result = await runToolContract(ensemblPredictVariant, { variant: 'rs334' });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            transcriptConsequences: [{ consequenceTerms: [] }],
            colocatedVariants: [{ clinicalSignificance: ['pathogenic'] }],
          },
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        'clinicalSignificanceByAllele',
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain('"sift"');
      expect(JSON.stringify(result.structuredContent)).not.toContain('"polyphen"');
      expect(JSON.stringify(result.content)).not.toContain('Variant allele');
    },
  );
  it.each([
    // rs63749819 as VEP reports it: the deletion allele's terms carry an empty allele key.
    [
      'a deletion keyed by an empty allele, on a record listing "-"',
      {
        id: 'rs63749819',
        allele_string: 'T/-',
        clin_sig_ref_allele: 'T',
        clin_sig_allele: ':pathogenic',
      },
      { '-': ['pathogenic'] },
    ],
    [
      'empty-key terms beside explicit ones, on a record listing "-"',
      { allele_string: 'TA/-/T', clin_sig_allele: 'T:benign;:pathogenic;:risk_factor' },
      { T: ['benign'], '-': ['pathogenic', 'risk_factor'] },
    ],
    // rs113993960 (CFTR F508del) as VEP reports it: its alleles list no "-", so the key stays unread.
    [
      'empty-key terms on a record whose alleles list no "-"',
      {
        id: 'rs113993960',
        allele_string: 'TCTT/T/TCTTCTT',
        clin_sig_ref_allele: 'CTT',
        clin_sig_allele: ':risk_factor;:pathogenic;:drug_response;:likely_pathogenic',
      },
      undefined,
    ],
  ])('attributes %s', async (_label, colocated, byAllele) => {
    http.route({
      match: () => true,
      respond: () =>
        Response.json([
          { colocated_variants: [{ clin_sig: ['pathogenic'], strand: 1, ...colocated }] },
        ]),
    });
    const result = await runToolContract(ensemblPredictVariant, { variant: 'rs334' });
    expect(result.isError).toBeUndefined();
    const cv = (
      result.structuredContent as {
        results: { colocatedVariants: { clinicalSignificanceByAllele?: object }[] }[];
      }
    ).results[0]!.colocatedVariants[0]!;
    expect(cv.clinicalSignificanceByAllele).toEqual(byAllele);
    const text = readMarkdownText(
      (result.content as { type: string; text: string }[]).map((block) => block.text).join('\n'),
    );
    if (byAllele) expect(text).toContain(`| -: ${byAllele['-'].join(', ')}`);
    else expect(text).not.toContain('| -: ');
  });

  it('renders SIFT and PolyPhen scores exactly as stored', async () => {
    http.route({
      match: () => true,
      respond: () =>
        Response.json([
          {
            transcript_consequences: [
              // BRCA2 c.2T>A and rs334's G allele as VEP scores them.
              {
                sift_prediction: 'deleterious',
                sift_score: 0,
                polyphen_prediction: 'possibly_damaging',
                polyphen_score: 0.858,
              },
              {
                sift_prediction: 'deleterious_low_confidence',
                sift_score: 0.01,
                polyphen_prediction: 'benign',
                polyphen_score: 0.08,
              },
              // Finer than any sampled score: a three-place render would round it.
              {
                sift_prediction: 'tolerated',
                sift_score: 0.0125,
                polyphen_prediction: 'probably_damaging',
                polyphen_score: 0.9876,
              },
            ],
          },
        ]),
    });
    const result = await runToolContract(ensemblPredictVariant, { variant: 'rs334' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          transcriptConsequences: [
            { sift: { score: 0 }, polyphen: { score: 0.858 } },
            { sift: { score: 0.01 }, polyphen: { score: 0.08 } },
            { sift: { score: 0.0125 }, polyphen: { score: 0.9876 } },
          ],
        },
      ],
    });
    const lines = (result.content as { type: string; text: string }[])
      .flatMap((block) => block.text.split('\n'))
      .filter((line) => /^\*\*(SIFT|PolyPhen):\*\*/.test(line));
    expect(lines).toEqual([
      '**SIFT:** deleterious (score: 0)',
      '**PolyPhen:** possibly_damaging (score: 0.858)',
      '**SIFT:** deleterious_low_confidence (score: 0.01)',
      '**PolyPhen:** benign (score: 0.08)',
      '**SIFT:** tolerated (score: 0.0125)',
      '**PolyPhen:** probably_damaging (score: 0.9876)',
    ]);
  });

  it('retains explicit allele terms safely without treating object keys as prototypes', async () => {
    http.route({
      match: () => true,
      respond: () =>
        Response.json([
          {
            colocated_variants: [
              {
                clin_sig_allele: '__proto__:other;A:pathogenic;bad;A:protective;constructor:benign',
              },
            ],
          },
        ]),
    });
    const result = await runToolContract(ensemblPredictVariant, { variant: 'rs334' });
    const output = result.structuredContent as {
      results: {
        colocatedVariants: { clinicalSignificanceByAllele: Record<string, string[]> }[];
      }[];
    };
    expect(
      Object.entries(output.results[0]!.colocatedVariants[0]!.clinicalSignificanceByAllele),
    ).toEqual([
      ['A', ['pathogenic', 'protective']],
      ['constructor', ['benign']],
    ]);
    expect(
      Object.getPrototypeOf(output.results[0]!.colocatedVariants[0]!.clinicalSignificanceByAllele),
    ).toBe(Object.prototype);
    expect(JSON.stringify(result.content)).toContain('A: pathogenic, protective');
  });
});

describe('lookup identity annotations', () => {
  it.each([
    { id: 'ENSG00000139618' },
    { symbol: 'BRCA2' },
    { ids: ['ENSG00000139618'] },
    { symbols: ['BRCA2'] },
  ])('preserves canonical/MANE metadata for %j', async (input) => {
    const record = {
      id: 'ENSG00000139618',
      canonical_transcript: 'ENST00000380152.8',
      Transcript: [
        {
          id: 'ENST00000380152',
          is_canonical: 1,
          MANE: [
            { type: 'MANE_Plus_Clinical', refseq_match: 'WRONG' },
            { type: 'MANE_Select', refseq_match: 'NM_000059.4' },
          ],
        },
      ],
    };
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json(
          request.method === 'POST'
            ? { ['ids' in input ? 'ENSG00000139618' : 'BRCA2']: record }
            : record,
        ),
    });
    const result = await runToolContract(ensemblLookupGene, { ...input, expand_transcripts: true });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      gene?: unknown;
      batch?: { succeeded: unknown[] };
    };
    expect(structured.gene ?? structured.batch!.succeeded[0]).toMatchObject({
      canonicalTranscript: 'ENST00000380152.8',
      transcripts: [{ maneSelect: 'NM_000059.4', isCanonical: true }],
    });
    for (const value of ['ENST00000380152.8', 'NM_000059.4'])
      expect(JSON.stringify(result.content)).toContain(value);
    expect(JSON.stringify(result.content)).toContain('ENST00000380152 ★ canonical');
    expect(Object.fromEntries(new URL(http.calls[0]!.request.url).searchParams)).toEqual({
      expand: '1',
      mane: '1',
    });
  });
  it.each(['Transcript', 'Translation', 'Exon', 'Gene', undefined])(
    'labels Parent as gene only for Transcript objects (%s)',
    async (object_type) => {
      http.route({
        match: () => true,
        respond: () =>
          Response.json({ id: 'ENST00000380152', Parent: 'ENSG00000139618', object_type }),
      });
      const result = await runToolContract(ensemblLookupGene, { id: 'ENST00000380152' });
      expect(result.isError).toBeUndefined();
      const output = result.structuredContent as { gene: object };
      if (object_type === 'Transcript') {
        expect(output.gene).toHaveProperty('parentGeneId', 'ENSG00000139618');
        expect(JSON.stringify(result.content)).toContain('**Parent gene:** ENSG00000139618');
      } else expect(output.gene).not.toHaveProperty('parentGeneId');
    },
  );
  it.each([undefined, [], [{ type: 'MANE_Plus_Clinical', refseq_match: 'NM_other' }]])(
    'omits missing Select annotations (%j)',
    async (MANE) => {
      http.route({
        match: () => true,
        respond: () => Response.json({ id: 'nonhuman', Transcript: [{ id: 'transcript', MANE }] }),
      });
      const result = await runToolContract(ensemblLookupGene, {
        id: 'nonhuman',
        expand_transcripts: true,
      });
      expect(result.structuredContent).toMatchObject({
        gene: { id: 'nonhuman', transcripts: [{ id: 'transcript', isCanonical: false }] },
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('maneSelect');
      expect(JSON.stringify(result.structuredContent)).not.toContain('canonicalTranscript');
      expect(JSON.stringify(result.content)).not.toContain('MANE Select');
    },
  );
  it('propagates expanded identity metadata through alias candidate resolution', async () => {
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname.includes('/lookup/symbol/'))
          return Response.json(
            { error: 'No valid lookup found for symbol ALIAS' },
            { status: 400 },
          );
        if (url.pathname.includes('/xrefs/'))
          return Response.json([{ id: 'ENSG00000139618', type: 'gene' }]);
        return Response.json({
          ENSG00000139618: {
            id: 'ENSG00000139618',
            canonical_transcript: 'ENST00000380152.8',
            Transcript: [
              {
                id: 'ENST00000380152',
                MANE: [{ type: 'MANE_Select', refseq_match: 'NM_000059.4' }],
              },
            ],
          },
        });
      },
    });
    const result = await runToolContract(ensemblLookupGene, {
      symbol: 'ALIAS',
      expand_transcripts: true,
    });
    expect(result.structuredContent).toMatchObject({
      gene: {
        matchedAlias: 'ALIAS',
        canonicalTranscript: 'ENST00000380152.8',
        transcripts: [{ maneSelect: 'NM_000059.4' }],
      },
    });
    expect(http.calls).toHaveLength(3);
    expect(new URL(http.calls[2]!.request.url).search).toBe('?expand=1&mane=1');
    expect(JSON.stringify(result.content)).toContain('NM_000059.4');
  });
  it('propagates canonical and MANE fields to the gene resource', async () => {
    http.route({
      match: () => true,
      respond: () =>
        Response.json({
          id: 'ENSG00000139618',
          canonical_transcript: 'ENST00000380152.8',
          Transcript: [
            { id: 'ENST00000380152', MANE: [{ type: 'MANE_Select', refseq_match: 'NM_000059.4' }] },
          ],
        }),
    });
    const result = await ensemblGeneResource.handler(
      { id: 'ENSG00000139618' },
      createMockContext({ errors: ensemblGeneResource.errors }),
    );
    expect(result).toMatchObject({
      canonicalTranscript: 'ENST00000380152.8',
      transcripts: [{ maneSelect: 'NM_000059.4' }],
    });
  });
});

describe('unversioned canonical transcript (issue #56)', () => {
  /** Fly p53 as Ensembl returns it: `canonical_transcript` ends in the empty version's dot. */
  const fly = {
    id: 'FBgn0039044',
    display_name: 'p53',
    species: 'drosophila_melanogaster',
    canonical_transcript: 'FBtr0084360.',
  };

  /** Answers every lookup path for the fly gene; the symbol path misses to reach alias resolution. */
  function routeFly(aliasOnly: boolean) {
    http.route({
      match: (request) => new URL(request.url).hostname === 'rest.ensembl.org',
      respond: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith('/lookup/symbol/') && request.method === 'GET')
          return aliasOnly
            ? Response.json({ error: 'No valid lookup found for symbol p53' }, { status: 400 })
            : Response.json(fly);
        if (pathname.startsWith('/xrefs/symbol/'))
          return Response.json([{ id: 'FBgn0039044', type: 'gene' }]);
        if (request.method === 'POST')
          return Response.json({
            [pathname.startsWith('/lookup/symbol/') ? 'p53' : 'FBgn0039044']: fly,
          });
        return Response.json(fly);
      },
    });
  }

  const textOf = (content: { type: string; text?: string }[] | undefined) =>
    (content ?? []).map((b) => b.text ?? '').join('\n');

  it.each([
    ['single symbol', { symbol: 'p53', species: 'drosophila_melanogaster' }, false],
    ['single id', { id: 'FBgn0039044' }, false],
    ['ids batch', { ids: ['FBgn0039044'] }, false],
    ['symbols batch', { symbols: ['p53'], species: 'drosophila_melanogaster' }, false],
    ['alias resolution', { symbol: 'p53', species: 'drosophila_melanogaster' }, true],
  ])('%s returns the transcript ID without the empty-version dot', async (_p, input, alias) => {
    routeFly(alias);
    const result = await runToolContract(ensemblLookupGene, input);
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      gene?: { canonicalTranscript?: string; matchedAlias?: string };
      batch?: { succeeded: { canonicalTranscript?: string }[] };
    };
    const gene = structured.gene ?? structured.batch!.succeeded[0];
    expect(gene?.canonicalTranscript).toBe('FBtr0084360');
    if (alias) expect(structured.gene?.matchedAlias).toBe('p53');
    expect(textOf(result.content).split('\n')).toContain('**Canonical transcript:** FBtr0084360');
  });

  it('returns the transcript ID without the empty-version dot from the gene resource', async () => {
    routeFly(false);
    const result = await ensemblGeneResource.handler(
      { id: 'FBgn0039044' },
      createMockContext({ errors: ensemblGeneResource.errors }),
    );
    expect(result).toMatchObject({ canonicalTranscript: 'FBtr0084360' });
  });
});
