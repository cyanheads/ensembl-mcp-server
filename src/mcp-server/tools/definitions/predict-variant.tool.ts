/**
 * @fileoverview Tool to predict functional consequences of sequence variants using Ensembl VEP.
 * @module mcp-server/tools/definitions/predict-variant
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { renderHeading } from '@/mcp-server/tools/render-heading.js';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { VepRecord } from '@/services/ensembl/types.js';

/** Ensembl's rejection of a species it does not know, on every VEP endpoint. */
const UNKNOWN_SPECIES = /can not find internal name for species/i;

const TranscriptConsequenceSchema = z.object({
  variantAllele: z
    .string()
    .optional()
    .describe('Allele this transcript consequence describes, in the upstream genomic orientation.'),
  canonical: z
    .boolean()
    .optional()
    .describe(
      'Whether Ensembl marks this consequence transcript as canonical. Omitted when not reported.',
    ),
  maneSelect: z
    .string()
    .optional()
    .describe('MANE Select RefSeq transcript accession, when supplied.'),
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
    .describe(
      'Aggregate clinical significance terms for the colocated record; these do not classify the submitted allele.',
    ),
  clinicalSignificanceByAllele: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe(
      'Clinical significance terms keyed by the allele explicitly annotated in the colocated record. Missing alleles have no reported attribution.',
    ),
  clinicalSignificanceReferenceAllele: z
    .string()
    .optional()
    .describe('Reference allele for the colocated clinical annotations, when reported.'),
  pubmed: z
    .array(z.number().describe('A PubMed ID for literature citing this variant.'))
    .optional()
    .describe(
      'PubMed IDs for literature associated with this variant, capped to ' +
        'max_pubmed_ids_per_variant. pubmedTotal reports the full count when the list was capped.',
    ),
  pubmedTotal: z
    .number()
    .optional()
    .describe(
      'Total PubMed IDs available for this variant before the max_pubmed_ids_per_variant cap. ' +
        'Equals the returned pubmed length when the list was not capped.',
    ),
});

const VepResultSchema = z.object({
  alleleString: z
    .string()
    .optional()
    .describe('Reference and alternate alleles returned by VEP, separated by slashes.'),
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
      'Per-transcript consequence details, capped to max_transcript_consequences. High-impact ' +
        'variants may affect many transcripts; canonical and maneSelect identify annotated primary transcripts. ' +
        'transcriptConsequencesTotal reports the full count.',
    ),
  transcriptConsequencesTotal: z
    .number()
    .optional()
    .describe(
      'Total transcript consequences available before the max_transcript_consequences cap. ' +
        'Equals the returned transcriptConsequences length when not capped.',
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
    'Accepts three input formats: HGVS notation (transcript-relative, e.g. ENST00000380152.8:c.2T>A, ' +
    'or genomic, e.g. 13:g.32316462T>A); region+allele (chr:start:end:strand/allele, e.g. 1:65568:65568:1/T); ' +
    'and a dbSNP rsID (e.g. rs334). Returns the most severe consequence term, affected transcripts and genes, ' +
    'impact level (HIGH/MODERATE/LOW/MODIFIER), and any colocated known variants with clinical significance. ' +
    'HGVS input: provide the full notation including transcript version for best results. ' +
    'Region+allele input: Ensembl normalizes chromosome names and canonical vertebrate output omits the chr ' +
    'prefix (a chr-prefixed name is also accepted). ' +
    'By default the response caps transcript consequences (max_transcript_consequences) and per-variant ' +
    'PubMed IDs (max_pubmed_ids_per_variant) to keep large VEP results compact — well-studied variants ' +
    'like rs334 otherwise carry 60+ consequences and 100+ citations. Truthful totals are always reported; ' +
    'set a cap to 0 (or include_all_colocated_pubmed=true) to retrieve the full set.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    variant: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Variant in one of three formats: ' +
          '(1) HGVS notation — transcript-relative: ENST00000380152.8:c.2T>A; ' +
          'genomic: 13:g.32316462T>A; ' +
          '(2) Region+allele: chr:start:end:strand/allele — e.g. 1:65568:65568:1/T ' +
          '(strand is 1 for forward or -1 for reverse); ' +
          '(3) dbSNP rsID — e.g. rs334. ' +
          'Ensembl normalizes chromosome names; canonical vertebrate output omits the "chr" prefix, ' +
          'though a chr-prefixed name is also accepted.',
      ),
    species: z
      .string()
      .trim()
      .min(1)
      .default('homo_sapiens')
      .describe(
        'Species in Ensembl internal format. Default is homo_sapiens. ' +
          'For non-human variants, set the appropriate species ' +
          '(e.g. mus_musculus for mouse). Use ensembl_list_species with nameContains (a genus or ' +
          'common name) to find valid values.',
      ),
    max_transcript_consequences: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe(
        'Maximum transcript consequences to return per VEP record. High-impact variants can affect ' +
          '60+ transcripts; the default keeps the response focused on the top consequences. ' +
          'Set to 0 to return every transcript consequence uncapped. ' +
          'transcriptConsequencesTotal on each record always reports the true pre-cap count.',
      ),
    max_pubmed_ids_per_variant: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe(
        'Maximum PubMed IDs to return per colocated known variant. Well-studied variants (e.g. rs334) ' +
          'cite 100+ papers; the default trims each list. Set to 0 to return every PubMed ID uncapped. ' +
          'pubmedTotal on each colocated variant reports the true pre-cap count. ' +
          'Ignored when include_all_colocated_pubmed is true.',
      ),
    include_all_colocated_pubmed: z
      .boolean()
      .default(false)
      .describe(
        'When true, return every PubMed ID for each colocated variant, overriding ' +
          'max_pubmed_ids_per_variant. Default false to keep responses compact.',
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
    notice: z
      .string()
      .optional()
      .describe('Guidance when no results are returned or when caps omitted detail.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when transcript consequences were capped at max_transcript_consequences.'),
    shown: z
      .number()
      .optional()
      .describe('Total transcript consequences returned across all records after the cap.'),
    cap: z.number().optional().describe('The max_transcript_consequences limit applied.'),
  },

  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
  },

  errors: [
    {
      reason: 'invalid_notation',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The variant notation is malformed or cannot be parsed by VEP.',
      recovery:
        'Provide HGVS (transcript-relative ENST…:c.POSREF>ALT or genomic CHR:g.POSREF>ALT), ' +
        'region+allele (chr:start:end:strand/allele), or a dbSNP rsID (e.g. rs334). ' +
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
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The species string was not recognized by Ensembl.',
      recovery:
        'Find the internal name with ensembl_list_species, setting nameContains to a genus or ' +
        'common name (e.g. mouse) and division for non-vertebrates. Names are lowercase_underscore ' +
        '(homo_sapiens, not Human).',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Predicting variant effect', { variant: input.variant, species: input.species });
    const service = getEnsemblService();

    // Route by input format: region+allele (chr:start:end:strand/allele) → /region;
    // else a dbSNP rsID (rs followed by digits) → /id; else HGVS notation → /hgvs.
    const regionAllelePattern = /^([^:]+):(\d+):(\d+):(-?1)\/(.+)$/;
    const rsIdPattern = /^rs\d+$/i;
    const regionMatch = input.variant.match(regionAllelePattern);

    const failOnUnknownSpecies = (msg: string) => {
      if (UNKNOWN_SPECIES.test(msg)) {
        throw ctx.fail('invalid_species', `Species "${input.species}" not recognized by Ensembl.`);
      }
    };

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
          failOnUnknownSpecies(msg);
          // "… matches reference [A]" and "Allele must be A,T,G,C or SO term" reject the allele.
          if (/invalid|unrecognized|parse|malformed|matches reference|allele must be/i.test(msg)) {
            throw ctx.fail(
              'invalid_notation',
              `Invalid region+allele notation "${input.variant}": ${msg}`,
            );
          }
          if (/not found|outside|no slice found/i.test(msg)) {
            throw ctx.fail('not_found', `Variant location not found: ${msg}`);
          }
          throw err;
        });
    } else if (rsIdPattern.test(input.variant)) {
      results = await service
        .predictVariantId(input.variant, input.species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          failOnUnknownSpecies(msg);
          // A well-formed rsID that dbSNP does not know reports "No variant found with ID …".
          if (/not found|no variant|unknown variant/i.test(msg)) {
            throw ctx.fail('not_found', `Variant identifier ${input.variant} not found in dbSNP.`);
          }
          if (/invalid|unrecognized|parse|malformed/i.test(msg)) {
            throw ctx.fail(
              'invalid_notation',
              `Invalid variant identifier "${input.variant}": ${msg}`,
            );
          }
          throw err;
        });
    } else {
      results = await service
        .predictVariantHgvs(input.variant, input.species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          failOnUnknownSpecies(msg);
          if (/invalid|unrecognized|parse|malformed|hgvs/i.test(msg)) {
            throw ctx.fail('invalid_notation', `Invalid HGVS notation "${input.variant}": ${msg}`);
          }
          if (/not found/i.test(msg)) {
            throw ctx.fail('not_found', `Variant ${input.variant} not found.`);
          }
          throw err;
        });
    }

    // VEP returns the full consequence + colocated-variant set; cap post-fetch so common
    // calls stay compact by default while the totals stay truthful. A cap of 0 (or
    // include_all_colocated_pubmed for the nested PubMed lists) disables it.
    const capConsequences = input.max_transcript_consequences > 0;
    const capPubmed = input.max_pubmed_ids_per_variant > 0 && !input.include_all_colocated_pubmed;
    let consequencesShown = 0;
    let consequencesTotal = 0;
    let pubmedCapped = false;

    const shaped = results.map((r) => {
      consequencesTotal += r.transcriptConsequences.length;
      const transcriptConsequences = capConsequences
        ? r.transcriptConsequences.slice(0, input.max_transcript_consequences)
        : r.transcriptConsequences;
      consequencesShown += transcriptConsequences.length;

      const colocatedVariants = r.colocatedVariants.map((cv) => {
        if (!cv.pubmed) return cv;
        const pubmedTotal = cv.pubmed.length;
        const pubmed = capPubmed ? cv.pubmed.slice(0, input.max_pubmed_ids_per_variant) : cv.pubmed;
        if (pubmed.length < pubmedTotal) pubmedCapped = true;
        return { ...cv, pubmed, pubmedTotal };
      });

      return {
        ...r,
        transcriptConsequences,
        transcriptConsequencesTotal: r.transcriptConsequences.length,
        colocatedVariants,
      };
    });

    if (shaped.length === 0) {
      ctx.enrich.notice(
        `No VEP results for "${input.variant}". ` +
          'Verify the notation format and that the position falls within an annotated region.',
      );
    } else {
      // Both caps can trip on one call (rs334: 66 consequences and 100+ PubMed IDs).
      // ctx.enrich.notice is last-wins, so compose the omission fragments into ONE string.
      const fragments: string[] = [];
      const consequencesOmitted = consequencesTotal - consequencesShown;
      if (consequencesOmitted > 0) {
        fragments.push(
          `showing ${consequencesShown} of ${consequencesTotal} transcript consequences`,
        );
      }
      if (pubmedCapped) {
        fragments.push(
          `capped PubMed IDs to ${input.max_pubmed_ids_per_variant} per colocated variant`,
        );
      }
      if (fragments.length > 0) {
        const guidance =
          `${fragments.join('; ')}. Raise max_transcript_consequences (0 returns all) ` +
          'or set include_all_colocated_pubmed=true for the full detail.';
        if (consequencesOmitted > 0) {
          ctx.enrich.truncated({
            shown: consequencesShown,
            cap: input.max_transcript_consequences,
            guidance,
          });
        } else {
          ctx.enrich.notice(guidance);
        }
      }
    }
    ctx.enrich.total(shaped.length);

    return { results: shaped, totalCount: shaped.length };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## VEP Results (${result.totalCount} record${result.totalCount !== 1 ? 's' : ''})`);

    if (result.results.length === 0) {
      lines.push('No VEP results returned for this variant.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      lines.push(`\n${renderHeading(3, `Variant: ${r.input ?? 'unknown'}`)}`);
      if (r.alleleString) lines.push(`**Alleles:** ${escapeMarkdownInline(r.alleleString)}`);
      if (r.chromosome && r.start != null) {
        lines.push(
          `**Location:** ${escapeMarkdownInline(r.chromosome)}:${r.start}${r.end !== r.start ? `-${r.end}` : ''}${r.assemblyName ? ` [${escapeMarkdownInline(r.assemblyName)}]` : ''}`,
        );
      }
      if (r.mostSevereConsequence) {
        lines.push(`**Most severe consequence:** ${escapeMarkdownInline(r.mostSevereConsequence)}`);
      }

      if (r.colocatedVariants.length > 0) {
        lines.push(`\n**Known colocated variants:**`);
        for (const cv of r.colocatedVariants) {
          let cvLine = `- ${escapeMarkdownInline(cv.id ?? 'novel')}`;
          if (cv.alleleString) cvLine += ` (${escapeMarkdownInline(cv.alleleString)})`;
          if (cv.clinicalSignificance?.length) {
            cvLine += ` — aggregate clinical significance: ${escapeMarkdownInline(cv.clinicalSignificance.join(', '))}`;
          }
          if (cv.clinicalSignificanceReferenceAllele)
            cvLine += ` | Clinical reference allele: ${escapeMarkdownInline(cv.clinicalSignificanceReferenceAllele)}`;
          for (const [allele, terms] of Object.entries(cv.clinicalSignificanceByAllele ?? {}))
            cvLine += ` | ${escapeMarkdownInline(allele)}: ${escapeMarkdownInline(terms.join(', '))}`;
          if (cv.pubmed?.length) {
            const pubmedTotal = cv.pubmedTotal ?? cv.pubmed.length;
            const pubmedSuffix =
              pubmedTotal > cv.pubmed.length
                ? ` (showing ${cv.pubmed.length} of ${pubmedTotal})`
                : '';
            cvLine += ` | PubMed: ${cv.pubmed.join(', ')}${pubmedSuffix}`;
          }
          lines.push(cvLine);
        }
      }

      if (r.transcriptConsequences.length > 0) {
        const shownTc = r.transcriptConsequences.length;
        const totalTc = r.transcriptConsequencesTotal ?? shownTc;
        const tcCount = totalTc > shownTc ? `${shownTc} of ${totalTc}` : `${shownTc}`;
        lines.push(`\n**Transcript consequences (${tcCount}):**`);
        for (const tc of r.transcriptConsequences) {
          const geneLabel = tc.geneSymbol ?? tc.geneId ?? 'unknown';
          lines.push(`\n${renderHeading(4, `${geneLabel} — ${tc.transcriptId ?? 'unknown'}`)}`);
          if (tc.variantAllele)
            lines.push(`**Variant allele:** ${escapeMarkdownInline(tc.variantAllele)}`);
          if (tc.canonical != null) lines.push(`**Ensembl canonical:** ${tc.canonical}`);
          if (tc.maneSelect) lines.push(`**MANE Select:** ${escapeMarkdownInline(tc.maneSelect)}`);
          if (tc.geneId && tc.geneSymbol)
            lines.push(`**Gene ID:** ${escapeMarkdownInline(tc.geneId)}`);
          lines.push(
            `**Impact:** ${escapeMarkdownInline(tc.impact ?? 'UNKNOWN')} | **Consequence:** ${escapeMarkdownInline(tc.consequenceTerms.join(', '))}`,
          );
          if (tc.biotype) lines.push(`**Biotype:** ${escapeMarkdownInline(tc.biotype)}`);
          if (tc.hgvsc) lines.push(`**HGVSc:** ${escapeMarkdownInline(tc.hgvsc)}`);
          if (tc.hgvsp) lines.push(`**HGVSp:** ${escapeMarkdownInline(tc.hgvsp)}`);
          if (tc.aminoAcids) lines.push(`**Amino acids:** ${escapeMarkdownInline(tc.aminoAcids)}`);
          if (tc.sift) {
            lines.push(
              `**SIFT:** ${escapeMarkdownInline(tc.sift.prediction)} (score: ${tc.sift.score.toFixed(3)})`,
            );
          }
          if (tc.polyphen) {
            lines.push(
              `**PolyPhen:** ${escapeMarkdownInline(tc.polyphen.prediction)} (score: ${tc.polyphen.score.toFixed(3)})`,
            );
          }
        }
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
