/**
 * @fileoverview CommonMark parity for upstream strings in tool results and notices.
 * @module tests/contract/markdown-parity.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { describe, expect, it, vi } from 'vitest';
import { ensemblGetHomology } from '@/mcp-server/tools/definitions/get-homology.tool.js';
import { ensemblGetSequence } from '@/mcp-server/tools/definitions/get-sequence.tool.js';
import { ensemblGetXrefs } from '@/mcp-server/tools/definitions/get-xrefs.tool.js';
import { ensemblListSpecies } from '@/mcp-server/tools/definitions/list-species.tool.js';
import { ensemblLookupGene } from '@/mcp-server/tools/definitions/lookup-gene.tool.js';
import { ensemblPredictVariant } from '@/mcp-server/tools/definitions/predict-variant.tool.js';
import { ensemblQueryRegion } from '@/mcp-server/tools/definitions/query-region.tool.js';
import { readMarkdownText } from '../helpers/read-markdown.js';

const getXrefsById = vi.fn();
vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ getXrefsById }),
}));

const marker = 'A*p* [label](https://example.com) <b>tag</b> `code` | ~tilde~';
const parser = new MarkdownIt('commonmark');

const cases = [
  [
    'species',
    () =>
      ensemblListSpecies.format!({
        species: [
          {
            name: marker,
            displayName: marker,
            commonName: marker,
            assembly: marker,
            taxonId: marker,
            division: marker,
          },
        ],
        totalCount: 1,
      }),
  ],
  [
    'gene',
    () =>
      ensemblLookupGene.format!({
        gene: {
          id: marker,
          displayName: marker,
          description: marker,
          canonicalTranscript: marker,
          parentGeneId: marker,
          matchedAlias: marker,
          species: marker,
          biotype: marker,
          chromosome: marker,
          assemblyName: marker,
          transcripts: [
            {
              id: marker,
              displayName: marker,
              maneSelect: marker,
              biotype: marker,
              isCanonical: false,
              start: 1,
              end: 2,
              strand: 1,
            },
          ],
        },
      }),
  ],
  [
    'ambiguous gene',
    () =>
      ensemblLookupGene.format!({
        ambiguous: {
          query: marker,
          guidance: marker,
          candidates: [{ id: marker, displayName: marker, description: marker }],
        },
      }),
  ],
  [
    'batch gene',
    () =>
      ensemblLookupGene.format!({
        batch: {
          succeeded: [{ query: marker, id: marker, displayName: marker, description: marker }],
          failed: [
            {
              query: marker,
              reason: 'ambiguous',
              error: marker,
              recovery: marker,
              candidates: [{ id: marker, displayName: marker, description: marker }],
            },
          ],
          omitted: [marker],
        },
      }),
  ],
  [
    'sequence',
    () =>
      ensemblGetSequence.format!({
        id: marker,
        type: marker,
        seq: 'ACGT',
        length: 4,
        offset: 0,
        truncated: false,
        description: marker,
      }),
  ],
  [
    'region',
    () =>
      ensemblQueryRegion.format!({
        species: marker,
        region: marker,
        assemblyName: marker,
        totalCount: 1,
        features: [
          {
            id: marker,
            name: marker,
            featureType: marker,
            chromosome: marker,
            start: 1,
            end: 2,
            description: marker,
            biotype: marker,
            parentId: marker,
            rank: 1,
            consequenceType: marker,
            clinicalSignificance: [marker],
          },
        ],
      }),
  ],
  [
    'homology',
    () =>
      ensemblGetHomology.format!({
        queryId: marker,
        querySpecies: marker,
        queryType: marker,
        totalCount: 1,
        homologs: [
          {
            targetId: marker,
            targetSymbol: marker,
            targetProteinId: marker,
            targetSpecies: marker,
            type: marker,
            taxonomyLevel: marker,
          },
        ],
      }),
  ],
  [
    'xrefs',
    () =>
      ensemblGetXrefs.format!({
        queriedId: marker,
        totalCount: 1,
        xrefs: [
          {
            primaryId: marker,
            displayId: `${marker} display`,
            description: marker,
            dbname: `${marker} database`,
            dbDisplayName: marker,
          },
        ],
      }),
  ],
  [
    'variant',
    () =>
      ensemblPredictVariant.format!({
        totalCount: 1,
        results: [
          {
            input: marker,
            alleleString: marker,
            chromosome: marker,
            start: 1,
            end: 2,
            assemblyName: marker,
            mostSevereConsequence: marker,
            transcriptConsequences: [
              {
                transcriptId: marker,
                geneSymbol: marker,
                geneId: marker,
                consequenceTerms: [marker],
                variantAllele: marker,
                maneSelect: marker,
                impact: marker,
                biotype: marker,
                hgvsc: marker,
                hgvsp: marker,
                aminoAcids: marker,
                sift: { prediction: marker, score: 0.1 },
                polyphen: { prediction: marker, score: 0.2 },
              },
            ],
            colocatedVariants: [
              {
                id: marker,
                alleleString: marker,
                clinicalSignificance: [marker],
                clinicalSignificanceReferenceAllele: marker,
                clinicalSignificanceByAllele: { [marker]: [marker] },
              },
            ],
          },
        ],
      }),
  ],
] as const;

const occurrences = {
  species: 6,
  gene: 14,
  'ambiguous gene': 5,
  'batch gene': 11,
  sequence: 3,
  region: 12,
  homology: 9,
  xrefs: 6,
  variant: 24,
};

describe('CommonMark result parity', () => {
  it.each(cases)(
    '%s preserves literal upstream text at every rendered occurrence',
    (name, render) => {
      const markdown = render()
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      const text = readMarkdownText(markdown);
      expect(text).toContain(marker);
      // Every occurrence must survive, including values interpolated into headings and emphasis.
      expect(text.split(marker).length - 1).toBe(occurrences[name]);
      expect(
        parser
          .parse(markdown, {})
          .flatMap((t) => t.children ?? [])
          .some((t) => t.type === 'link_open' || t.type === 'html_inline'),
      ).toBe(false);
    },
  );

  it('keeps structured xref data raw while its text reads back literally', async () => {
    getXrefsById.mockResolvedValueOnce([
      { primaryId: marker, description: marker, dbname: marker },
    ]);
    const result = await runToolContract(ensemblGetXrefs, { id: marker });
    expect(result.structuredContent).toMatchObject({
      queriedId: marker,
      xrefs: [{ primaryId: marker, description: marker, dbname: marker }],
    });
    expect(
      readMarkdownText(result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')),
    ).toContain(marker);
  });

  it('escapes only the rendered notice, preserving its raw structured value', async () => {
    getXrefsById.mockResolvedValueOnce([]);
    const result = await runToolContract(ensemblGetXrefs, { id: marker });
    expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(marker) });
    const text = readMarkdownText(
      result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    );
    expect(text.split(marker).length - 1).toBe(2);
  });

  it.each(['A\n- B', 'A\r\n- B'])('preserves a multiline query %j on both surfaces', async (id) => {
    getXrefsById.mockResolvedValueOnce([]);
    const result = await runToolContract(ensemblGetXrefs, { id });
    expect(result.structuredContent).toMatchObject({
      queriedId: id,
      notice: expect.stringContaining(id),
    });
    const text = readMarkdownText(
      result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    );
    expect(text.split('A\n- B').length - 1).toBe(2);
    expect(text).not.toContain('A\\');
  });
});
