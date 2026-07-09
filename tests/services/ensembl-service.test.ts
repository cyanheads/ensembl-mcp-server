/**
 * @fileoverview Tests for EnsemblService normalization and endpoint routing.
 * Fixtures mirror live rest.ensembl.org response shapes.
 * @module tests/services/ensembl-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnsemblService, initEnsemblService } from '@/services/ensembl/ensembl-service.js';

const mockFetch = vi.fn();

/** Build a minimal fetch Response stub carrying a JSON body, matching what fetchJson reads. */
function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('EnsemblService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    initEnsemblService({} as AppConfig, createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('queryRegion exon normalization (issue #9)', () => {
    // Mirrors the raw /overlap/region/.../feature=exon shape: the same exon id is
    // returned once per parent transcript it belongs to, each row carrying Parent + rank.
    const rawExonOverlap = [
      {
        exon_id: 'ENSE00003856928',
        id: 'ENSE00003856928',
        Parent: 'ENST00000544455',
        rank: 1,
        constitutive: 0,
        ensembl_phase: -1,
        ensembl_end_phase: -1,
        start: 32315086,
        end: 32315145,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
        source: 'havana',
        version: 1,
      },
      {
        exon_id: 'ENSE00001484009',
        id: 'ENSE00001484009',
        Parent: 'ENST00000544455',
        rank: 2,
        start: 32316422,
        end: 32316527,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
      },
      {
        exon_id: 'ENSE00001484009',
        id: 'ENSE00001484009',
        Parent: 'ENST00000380152',
        rank: 2,
        start: 32316422,
        end: 32316527,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
      },
      {
        exon_id: 'ENSE00001484009',
        id: 'ENSE00001484009',
        Parent: 'ENST00000666593',
        rank: 2,
        start: 32316422,
        end: 32316527,
        strand: 1,
        seq_region_name: '13',
        feature_type: 'exon',
        assembly_name: 'GRCh38',
      },
    ];

    it('surfaces a distinct parent transcript for each repeated exon row', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(rawExonOverlap));
      const ctx = createMockContext();
      const features = await getEnsemblService().queryRegion(
        'homo_sapiens',
        '13:32315086-32317000',
        ['exon'],
        undefined,
        ctx,
      );

      const repeated = features.filter((f) => f.id === 'ENSE00001484009');
      expect(repeated).toHaveLength(3);
      // The repeated exon id is not a duplicate — each row is discriminated by parentId.
      const parents = repeated.map((f) => f.parentId);
      expect(new Set(parents).size).toBe(3);
      expect(parents).toEqual(
        expect.arrayContaining(['ENST00000544455', 'ENST00000380152', 'ENST00000666593']),
      );
      // rank is carried through from the raw payload.
      expect(repeated.every((f) => f.rank === 2)).toBe(true);
    });

    it('maps raw Parent/rank onto parentId/rank', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([rawExonOverlap[0]]));
      const ctx = createMockContext();
      const [feature] = await getEnsemblService().queryRegion(
        'homo_sapiens',
        '13:32315086-32317000',
        ['exon'],
        undefined,
        ctx,
      );
      expect(feature?.parentId).toBe('ENST00000544455');
      expect(feature?.rank).toBe(1);
      expect(feature?.featureType).toBe('exon');
    });
  });

  describe('predictVariantId (issue #11)', () => {
    it('hits the VEP /id endpoint and normalizes the record', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'rs334',
            input: 'rs334',
            most_severe_consequence: 'missense_variant',
            seq_region_name: '11',
            start: 5227002,
            end: 5227002,
            assembly_name: 'GRCh38',
            transcript_consequences: [
              {
                gene_symbol: 'HBB',
                consequence_terms: ['missense_variant'],
                impact: 'MODERATE',
                amino_acids: 'E/V',
              },
            ],
            colocated_variants: [{ id: 'rs334', allele_string: 'T/A' }],
          },
        ]),
      );
      const ctx = createMockContext();
      const records = await getEnsemblService().predictVariantId('rs334', 'homo_sapiens', ctx);

      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('/vep/homo_sapiens/id/rs334');
      expect(records).toHaveLength(1);
      expect(records[0]?.mostSevereConsequence).toBe('missense_variant');
      expect(records[0]?.transcriptConsequences[0]?.geneSymbol).toBe('HBB');
      expect(records[0]?.transcriptConsequences[0]?.impact).toBe('MODERATE');
    });
  });

  describe('getSequenceById expand params (issue #13)', () => {
    const seqBody = { id: 'ENSG00000139618', seq: 'ACGTACGT', molecule: 'dna' };

    it('appends expand_5prime/expand_3prime for genomic stable-ID lookups', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(seqBody));
      const ctx = createMockContext();
      await getEnsemblService().getSequenceById('ENSG00000139618', 'genomic', 10, 10, ctx);

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('/sequence/id/ENSG00000139618');
      expect(url).toContain('type=genomic');
      expect(url).toContain('expand_5prime=10');
      expect(url).toContain('expand_3prime=10');
    });

    it('omits expand params when both are zero', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(seqBody));
      const ctx = createMockContext();
      await getEnsemblService().getSequenceById('ENSG00000139618', 'genomic', 0, 0, ctx);

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('type=genomic');
      expect(url).not.toContain('expand_5prime');
      expect(url).not.toContain('expand_3prime');
    });

    it('does not append expand params for non-genomic types', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'ENST00000380152', seq: 'MPEEK' }));
      const ctx = createMockContext();
      await getEnsemblService().getSequenceById('ENST00000380152', 'protein', 10, 10, ctx);

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('type=protein');
      expect(url).not.toContain('expand_5prime');
      expect(url).not.toContain('expand_3prime');
    });
  });

  describe('getSequenceByRegion (issue #14)', () => {
    it('builds a /sequence/region/ URL and honors expand params', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'chromosome:GRCh38:13', seq: 'ACGTACGT' }),
      );
      const ctx = createMockContext();
      await getEnsemblService().getSequenceByRegion(
        'homo_sapiens',
        '13:32315086-32315100',
        10,
        10,
        ctx,
      );

      // The colon in the region is percent-encoded on the wire; decode to assert the path shape.
      const url = decodeURIComponent(mockFetch.mock.calls[0]?.[0] as string);
      expect(url).toContain('/sequence/region/homo_sapiens/13:32315086-32315100');
      expect(url).toContain('expand_5prime=10');
      expect(url).toContain('expand_3prime=10');
    });
  });
});
