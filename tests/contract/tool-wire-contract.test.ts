/**
 * @fileoverview Wire-contract tests for the tool surface — the envelope a client
 * actually receives, rather than the value a handler returns. Every other suite
 * calls `handler()` and `format()` separately, which skips argument parsing, the
 * error envelope, and the pairing of `structuredContent` with `content[]`.
 * `runToolContract` runs the production path, so these assertions cover both
 * consumption surfaces at once.
 * @module tests/contract/tool-wire-contract.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGetSequence } from '@/mcp-server/tools/definitions/get-sequence.tool.js';
import { ensemblGetXrefs } from '@/mcp-server/tools/definitions/get-xrefs.tool.js';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import type { VepRecord } from '@/services/ensembl/types.js';

const mockGetXrefsById = vi.fn();
const mockPredictVariantId = vi.fn();
const mockPredictVariantHgvs = vi.fn();
const mockGetSequenceById = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({
    getXrefsById: mockGetXrefsById,
    predictVariantId: mockPredictVariantId,
    predictVariantHgvs: mockPredictVariantHgvs,
    getSequenceById: mockGetSequenceById,
  }),
}));

/** The protocol result a client receives, taken from the runner rather than re-imported. */
type ToolContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** Concatenated text of every `content[]` block — what a `content`-only client reads. */
function contentText(result: ToolContractResult): string {
  return (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function errorData(result: ToolContractResult): Record<string, unknown> {
  const structured = result.structuredContent as { error?: { data?: Record<string, unknown> } };
  return structured.error?.data ?? {};
}

/** rs334 (HbS) shaped down to one transcript and one colocated variant, with every nested arm populated. */
const rs334: VepRecord = {
  input: 'rs334',
  chromosome: '11',
  start: 5227002,
  end: 5227002,
  assemblyName: 'GRCh38',
  mostSevereConsequence: 'missense_variant',
  transcriptConsequences: [
    {
      transcriptId: 'ENST00000335295',
      geneId: 'ENSG00000244734',
      geneSymbol: 'HBB',
      consequenceTerms: ['missense_variant'],
      impact: 'MODERATE',
      biotype: 'protein_coding',
      hgvsc: 'ENST00000335295.4:c.20A>T',
      hgvsp: 'ENSP00000333994.3:p.Glu7Val',
      aminoAcids: 'E/V',
      sift: { prediction: 'deleterious', score: 0.02 },
      polyphen: { prediction: 'possibly_damaging', score: 0.86 },
    },
    {
      transcriptId: 'ENST00000633227',
      geneId: 'ENSG00000244734',
      geneSymbol: 'HBB',
      consequenceTerms: ['non_coding_transcript_exon_variant'],
      impact: 'MODIFIER',
      biotype: 'processed_transcript',
    },
  ],
  colocatedVariants: [
    {
      id: 'rs334',
      alleleString: 'A/T',
      clinicalSignificance: ['pathogenic', 'drug-response'],
      pubmed: [1, 2, 3, 4, 5],
    },
  ],
};

describe('tool wire contract — error envelope', () => {
  it('carries reason, recovery hint, and the reason suffix on both surfaces', async () => {
    mockGetXrefsById.mockRejectedValueOnce(new Error('ID ENSG99999999999 not found in Ensembl'));
    const declaredRecovery = ensemblGetXrefs.errors?.find(
      (e) => e.reason === 'not_found',
    )?.recovery;
    expect(declaredRecovery).toBeDefined();

    const result = await runToolContract(ensemblGetXrefs, { id: 'ENSG99999999999' });

    expect(result.isError).toBe(true);

    // structuredContent surface
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'not_found', recovery: { hint: declaredRecovery } },
      },
    });

    // content[] surface — the same three facts, rendered
    const text = contentText(result);
    expect(text).toContain('ENSG99999999999');
    expect(text).toContain(`Recovery: ${declaredRecovery}`);
    expect(text).toContain('(reason not_found)');
  });

  it('distinguishes a second declared reason on the same surfaces', async () => {
    mockPredictVariantHgvs.mockRejectedValueOnce(new Error('Unable to parse HGVS notation'));
    const declaredRecovery = ensemblPredictVariant.errors?.find(
      (e) => e.reason === 'invalid_notation',
    )?.recovery;

    const result = await runToolContract(ensemblPredictVariant, { variant: 'ENST123:c.junk' });

    expect(result.isError).toBe(true);
    expect(errorData(result)).toMatchObject({
      reason: 'invalid_notation',
      recovery: { hint: declaredRecovery },
    });
    expect(contentText(result)).toContain('(reason invalid_notation)');
  });
});

describe('tool wire contract — argument rejection', () => {
  it('rejects a missing required field as InvalidParams with a recovery hint', async () => {
    const result = await runToolContract(ensemblGetXrefs, {} as never);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(errorData(result)).toMatchObject({ reason: 'invalid_arguments' });

    const text = contentText(result);
    expect(text).toContain('ensembl_get_xrefs');
    expect(text).toContain('id');
    expect(text).toContain('Recovery:');
  });

  it('rejects a blank required identifier before the handler runs (issue #22)', async () => {
    mockGetXrefsById.mockClear();
    const result = await runToolContract(ensemblGetXrefs, { id: '   ' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(errorData(result)).toMatchObject({
      reason: 'invalid_arguments',
      issues: [{ code: 'too_small', path: ['id'] }],
    });
    const text = contentText(result);
    expect(text).toContain('ensembl_get_xrefs');
    expect(text).toContain('(reason invalid_arguments)');
    expect(mockGetXrefsById).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range value', async () => {
    const result = await runToolContract(ensemblPredictVariant, {
      variant: 'rs334',
      max_transcript_consequences: -1,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(contentText(result)).toContain('max_transcript_consequences');
  });
});

describe('tool wire contract — input pre-validation', () => {
  it('ignores a client-added root key instead of rejecting the call', async () => {
    mockGetXrefsById.mockResolvedValueOnce([{ dbname: 'HGNC', primaryId: 'HGNC:1101' }]);

    const result = await runToolContract(ensemblGetXrefs, {
      id: 'ENSG00000139618',
      _clientTrace: 'abc-123',
    } as never);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ queriedId: 'ENSG00000139618' });
  });

  it('rewrites a case-style alias onto the declared key', async () => {
    mockGetXrefsById.mockResolvedValueOnce([{ dbname: 'HGNC', primaryId: 'HGNC:1101' }]);

    const result = await runToolContract(ensemblGetXrefs, {
      id: 'ENSG00000139618',
      dbName: 'HGNC',
    } as never);

    expect(result.isError).toBeUndefined();
    // The alias reached the service as the declared `dbname` filter, not as undefined.
    expect(mockGetXrefsById).toHaveBeenCalledWith('ENSG00000139618', 'HGNC', expect.anything());
  });

  it('rewrites a snake_case alias for a camelCase-spelling caller', async () => {
    mockPredictVariantId.mockResolvedValueOnce([rs334]);

    const result = await runToolContract(ensemblPredictVariant, {
      variant: 'rs334',
      maxTranscriptConsequences: 1,
    } as never);

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { results: VepRecord[] };
    expect(structured.results[0]?.transcriptConsequences).toHaveLength(1);
  });
});

describe('tool wire contract — nested success payload', () => {
  it('carries the full nested VEP record on structuredContent and renders it into content[]', async () => {
    mockPredictVariantId.mockResolvedValueOnce([rs334]);

    const result = await runToolContract(ensemblPredictVariant, { variant: 'rs334' });

    expect(result.isError).toBeUndefined();

    // structuredContent surface — depth preserved down to the pathogenicity arms
    expect(result.structuredContent).toMatchObject({
      totalCount: 1,
      results: [
        {
          mostSevereConsequence: 'missense_variant',
          transcriptConsequencesTotal: 2,
          transcriptConsequences: [
            {
              transcriptId: 'ENST00000335295',
              geneSymbol: 'HBB',
              hgvsp: 'ENSP00000333994.3:p.Glu7Val',
              sift: { prediction: 'deleterious', score: 0.02 },
              polyphen: { prediction: 'possibly_damaging', score: 0.86 },
            },
            { transcriptId: 'ENST00000633227', impact: 'MODIFIER' },
          ],
          colocatedVariants: [
            {
              id: 'rs334',
              clinicalSignificance: ['pathogenic', 'drug-response'],
              pubmed: [1, 2, 3, 4, 5],
              pubmedTotal: 5,
            },
          ],
        },
      ],
    });

    // content[] surface — a client that reads only text gets the same facts
    const text = contentText(result);
    expect(text).toContain('11:5227002');
    expect(text).toContain('missense_variant');
    expect(text).toContain('ENST00000335295');
    expect(text).toContain('ENSP00000333994.3:p.Glu7Val');
    expect(text).toContain('deleterious');
    expect(text).toContain('0.020');
    expect(text).toContain('possibly_damaging');
    expect(text).toContain('0.860');
    expect(text).toContain('pathogenic, drug-response');
    expect(text).toContain('PubMed: 1, 2, 3, 4, 5');
    expect(text).toContain('ENST00000633227');
  });

  it('reports truthful totals on both surfaces when a cap trims the nested list', async () => {
    mockPredictVariantId.mockResolvedValueOnce([rs334]);

    const result = await runToolContract(ensemblPredictVariant, {
      variant: 'rs334',
      max_transcript_consequences: 1,
      max_pubmed_ids_per_variant: 2,
    });

    const structured = result.structuredContent as {
      results: Array<{
        transcriptConsequences: unknown[];
        transcriptConsequencesTotal: number;
        colocatedVariants: Array<{ pubmed: number[]; pubmedTotal: number }>;
      }>;
    };
    expect(structured.results[0]?.transcriptConsequences).toHaveLength(1);
    expect(structured.results[0]?.transcriptConsequencesTotal).toBe(2);
    expect(structured.results[0]?.colocatedVariants[0]?.pubmed).toEqual([1, 2]);
    expect(structured.results[0]?.colocatedVariants[0]?.pubmedTotal).toBe(5);

    const text = contentText(result);
    expect(text).toContain('1 of 2');
    expect(text).toContain('showing 2 of 5');
  });
});

describe('tool wire contract — sequence window (issue #19)', () => {
  it('carries the same bounded window, truthful length, and next offset on both surfaces', async () => {
    const full = 'ACGTTGCA'.repeat(2_000).slice(0, 15_001);
    mockGetSequenceById.mockResolvedValueOnce({
      id: 'ENSG00000139618',
      type: 'genomic',
      seq: full,
      length: full.length,
    });

    const result = await runToolContract(ensemblGetSequence, {
      id: 'ENSG00000139618',
      offset: 10_000,
      max_length: 5_000,
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { seq: string; notice?: string };
    expect(structured).toMatchObject({
      length: 15_001,
      offset: 10_000,
      truncated: true,
      nextOffset: 15_000,
    });
    expect(structured.seq).toBe(full.slice(10_000, 15_000));
    expect(structured.notice).toContain('offset 15000');

    const text = contentText(result);
    expect(text).toContain(full.slice(10_000, 15_000));
    expect(text).toContain('15,001 bp');
    expect(text).toContain('next offset 15000');
    expect(text).toContain(`> ${structured.notice}`);
  });
});
