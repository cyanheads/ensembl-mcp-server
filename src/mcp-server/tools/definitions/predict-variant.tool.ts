/**
 * @fileoverview Tool to predict functional consequences of sequence variants using Ensembl VEP.
 * @module mcp-server/tools/definitions/predict-variant
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { VepRecord } from '@/services/ensembl/types.js';

const TranscriptConsequenceSchema = z.object({
  transcriptId: z
    .string()
    .optional()
    .describe('Ensembl transcript ID (ENST…) affected by this variant.'),
  geneId: z
    .string()
    .optional()
    .describe('Ensembl gene ID (ENSG…) harboring the affected transcript.'),
  geneSymbol: z.string().optional().describe('Gene symbol (e.g. BRCA2, TP53).'),
  consequenceTerms: z
    .array(
      z
        .string()
        .describe('A Sequence Ontology consequence term (e.g. missense_variant, stop_gained).'),
    )
    .describe('Sequence Ontology consequence terms for this transcript.'),
  impact: z
    .string()
    .optional()
    .describe(
      'Impact level: HIGH (frameshift, stop_gained), MODERATE (missense), LOW (synonymous), or MODIFIER.',
    ),
  biotype: z.string().optional().describe('Transcript biotype (e.g. protein_coding).'),
  hgvsc: z.string().optional().describe('HGVS notation at the cDNA level (e.g. c.2T>A).'),
  hgvsp: z.string().optional().describe('HGVS notation at the protein level (e.g. p.Met1Thr).'),
  aminoAcids: z
    .string()
    .optional()
    .describe('Reference/alternate amino acids separated by "/" (e.g. M/T).'),
  sift: z
    .object({
      prediction: z.string().describe('SIFT prediction: deleterious or tolerated.'),
      score: z
        .number()
        .describe('SIFT score (0-1). Lower scores indicate more deleterious variants.'),
    })
    .optional()
    .describe('SIFT pathogenicity prediction for missense variants. Omitted when not applicable.'),
  polyphen: z
    .object({
      prediction: z
        .string()
        .describe('PolyPhen prediction: probably_damaging, possibly_damaging, or benign.'),
      score: z
        .number()
        .describe('PolyPhen score (0-1). Higher scores indicate more damaging variants.'),
    })
    .optional()
    .describe(
      'PolyPhen pathogenicity prediction for missense variants. Omitted when not applicable.',
    ),
});

const ColocatedVariantSchema = z.object({
  id: z.string().optional().describe('Known variant ID (e.g. rs1234567 for dbSNP entries).'),
  alleleString: z
    .string()
    .optional()
    .describe('Allele string showing reference/alternate (e.g. A/T).'),
  clinicalSignificance: z
    .array(z.string().describe('A clinical significance term for this colocated known variant.'))
    .optional()
    .describe('Clinical significance terms from ClinVar (e.g. pathogenic, benign).'),
  pubmed: z
    .array(z.number().describe('A PubMed ID for literature citing this variant.'))
    .optional()
    .describe('PubMed IDs for literature associated with this variant.'),
});

const VepResultSchema = z.object({
  input: z.string().optional().describe('The input variant notation as submitted to VEP.'),
  chromosome: z.string().optional().describe('Chromosome the variant is on.'),
  start: z.number().optional().describe('Variant start position (1-based).'),
  end: z.number().optional().describe('Variant end position (1-based).'),
  assemblyName: z.string().optional().describe('Genome assembly name (e.g. GRCh38).'),
  mostSevereConsequence: z
    .string()
    .optional()
    .describe(
      'Most severe Sequence Ontology consequence term across all transcripts ' +
        '(e.g. stop_gained, missense_variant, synonymous_variant).',
    ),
  transcriptConsequences: z
    .array(
      TranscriptConsequenceSchema.describe(
        'Consequence details for one affected transcript, including impact, HGVS notation, and pathogenicity scores.',
      ),
    )
    .describe(
      'Per-transcript consequence details. High-impact variants may affect many transcripts; ' +
        'focus on canonical transcripts (isCanonical from ensembl_lookup_gene) for primary effect.',
    ),
  colocatedVariants: z
    .array(
      ColocatedVariantSchema.describe(
        'A known variant at the same genomic position from public databases (dbSNP, ClinVar).',
      ),
    )
    .describe(
      'Known variants at the same position from public databases (dbSNP, ClinVar). ' +
        'Empty when the variant is novel.',
    ),
});

export const ensemblPredictVariant = tool('ensembl_predict_variant', {
  title: 'Predict Variant Effect',
  description:
    'Predict the functional consequences of a sequence variant using the Ensembl Variant Effect Predictor (VEP). ' +
    'Accepts HGVS notation (transcript-relative, e.g. ENST00000380152.8:c.2T>A, or genomic, ' +
    'e.g. 13:g.32316462T>A) and also region+allele format (chr:start:end:strand/allele, ' +
    'e.g. 1:65568:65568:1/T). Returns the most severe consequence term, affected transcripts and genes, ' +
    'impact level (HIGH/MODERATE/LOW/MODIFIER), and any colocated known variants with clinical significance. ' +
    'HGVS input: provide the full notation including transcript version for best results. ' +
    'Region+allele input: use Ensembl chromosome naming (no chr prefix for vertebrates).',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    variant: z
      .string()
      .describe(
        'Variant in one of two formats: ' +
          '(1) HGVS notation — transcript-relative: ENST00000380152.8:c.2T>A; ' +
          'genomic: 13:g.32316462T>A; ' +
          '(2) Region+allele: chr:start:end:strand/allele — e.g. 1:65568:65568:1/T. ' +
          'For region+allele, strand is 1 (forward) or -1 (reverse); ' +
          'chromosome names use no "chr" prefix for vertebrates.',
      ),
    species: z
      .string()
      .default('homo_sapiens')
      .describe(
        'Species in Ensembl internal format. Default is homo_sapiens. ' +
          'For non-human variants, set the appropriate species ' +
          '(e.g. mus_musculus for mouse). Use ensembl_list_species to discover valid values.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        VepResultSchema.describe(
          'VEP consequence record for one genomic position, with transcript consequences and colocated known variants.',
        ),
      )
      .describe(
        'VEP consequence records — typically one per input variant. ' +
          'Multiple records appear when a single notation matches multiple genomic positions.',
      ),
    totalCount: z.number().describe('Number of VEP consequence records returned.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no results are returned.'),
  },

  errors: [
    {
      reason: 'invalid_notation',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The variant notation is malformed or cannot be parsed by VEP.',
      recovery:
        'Check HGVS format: transcript-relative uses ENST…:c.POSREF>ALT; ' +
        'genomic uses CHR:g.POSREF>ALT. ' +
        'Region+allele format is chr:start:end:strand/allele. ' +
        'Verify the transcript version matches the current Ensembl release.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The variant location falls outside any known transcript or assembly region.',
      recovery:
        'Verify the chromosome and position are within the target assembly bounds. ' +
        'Use ensembl_query_region to confirm the genomic context around the position.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Predicting variant effect', { variant: input.variant, species: input.species });
    const service = getEnsemblService();

    // Detect region+allele format: chr:start:end:strand/allele
    const regionAllelePattern = /^([^:]+):(\d+):(\d+):(-?1)\/(.+)$/;
    const regionMatch = input.variant.match(regionAllelePattern);

    let results: VepRecord[];
    if (regionMatch) {
      const [, chr, start, end, strand, allele] = regionMatch as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      results = await service
        .predictVariantRegion(
          chr,
          Number(start),
          Number(end),
          Number(strand),
          allele,
          input.species,
          ctx,
        )
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/invalid|unrecognized|parse|malformed/i.test(msg)) {
            throw ctx.fail(
              'invalid_notation',
              `Invalid region+allele notation "${input.variant}": ${msg}`,
            );
          }
          if (/not found|outside/i.test(msg)) {
            throw ctx.fail('not_found', `Variant location not found: ${msg}`);
          }
          throw err;
        });
    } else {
      results = await service
        .predictVariantHgvs(input.variant, input.species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/invalid|unrecognized|parse|malformed|hgvs/i.test(msg)) {
            throw ctx.fail('invalid_notation', `Invalid HGVS notation "${input.variant}": ${msg}`);
          }
          if (/not found/i.test(msg)) {
            throw ctx.fail('not_found', `Variant ${input.variant} not found.`);
          }
          throw err;
        });
    }

    if (results.length === 0) {
      ctx.enrich.notice(
        `No VEP results for "${input.variant}". ` +
          'Verify the notation format and that the position falls within an annotated region.',
      );
    }
    ctx.enrich.total(results.length);

    return { results, totalCount: results.length };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## VEP Results (${result.totalCount} record${result.totalCount !== 1 ? 's' : ''})`);

    if (result.results.length === 0) {
      lines.push('No VEP results returned for this variant.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      lines.push(`\n### Variant: ${r.input ?? 'unknown'}`);
      if (r.chromosome && r.start != null) {
        lines.push(
          `**Location:** ${r.chromosome}:${r.start}${r.end !== r.start ? `-${r.end}` : ''}${r.assemblyName ? ` [${r.assemblyName}]` : ''}`,
        );
      }
      if (r.mostSevereConsequence) {
        lines.push(`**Most severe consequence:** ${r.mostSevereConsequence}`);
      }

      if (r.colocatedVariants.length > 0) {
        lines.push(`\n**Known colocated variants:**`);
        for (const cv of r.colocatedVariants) {
          let cvLine = `- ${cv.id ?? 'novel'}`;
          if (cv.alleleString) cvLine += ` (${cv.alleleString})`;
          if (cv.clinicalSignificance?.length) {
            cvLine += ` — ${cv.clinicalSignificance.join(', ')}`;
          }
          if (cv.pubmed?.length) {
            cvLine += ` | PubMed: ${cv.pubmed.join(', ')}`;
          }
          lines.push(cvLine);
        }
      }

      if (r.transcriptConsequences.length > 0) {
        lines.push(`\n**Transcript consequences (${r.transcriptConsequences.length}):**`);
        for (const tc of r.transcriptConsequences) {
          const geneLabel = tc.geneSymbol ?? tc.geneId ?? 'unknown';
          lines.push(`\n#### ${geneLabel} — ${tc.transcriptId ?? 'unknown'}`);
          if (tc.geneId && tc.geneSymbol) lines.push(`**Gene ID:** ${tc.geneId}`);
          lines.push(
            `**Impact:** ${tc.impact ?? 'UNKNOWN'} | **Consequence:** ${tc.consequenceTerms.join(', ')}`,
          );
          if (tc.biotype) lines.push(`**Biotype:** ${tc.biotype}`);
          if (tc.hgvsc) lines.push(`**HGVSc:** ${tc.hgvsc}`);
          if (tc.hgvsp) lines.push(`**HGVSp:** ${tc.hgvsp}`);
          if (tc.aminoAcids) lines.push(`**Amino acids:** ${tc.aminoAcids}`);
          if (tc.sift) {
            lines.push(`**SIFT:** ${tc.sift.prediction} (score: ${tc.sift.score.toFixed(3)})`);
          }
          if (tc.polyphen) {
            lines.push(
              `**PolyPhen:** ${tc.polyphen.prediction} (score: ${tc.polyphen.score.toFixed(3)})`,
            );
          }
        }
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
