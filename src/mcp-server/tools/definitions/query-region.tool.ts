/**
 * @fileoverview Tool to find genomic features overlapping a chromosomal region.
 * @module mcp-server/tools/definitions/query-region
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const FEATURE_TYPES = ['gene', 'transcript', 'variation', 'regulatory', 'exon'] as const;

const FeatureSchema = z.object({
  id: z.string().optional().describe('Ensembl stable ID for this feature (e.g. ENSG…, rs…).'),
  name: z.string().optional().describe('External name or symbol for this feature.'),
  featureType: z
    .string()
    .describe('Feature type: gene, transcript, variation, regulatory, or exon.'),
  biotype: z
    .string()
    .optional()
    .describe('Biotype of the feature (e.g. protein_coding, lncRNA, SNV).'),
  chromosome: z.string().describe('Chromosome or sequence region name.'),
  start: z.number().describe('Start position on the chromosome (1-based).'),
  end: z.number().describe('End position on the chromosome (1-based).'),
  strand: z.number().optional().describe('Strand: 1 for forward, -1 for reverse.'),
  description: z.string().optional().describe('Feature description when provided.'),
  consequenceType: z
    .string()
    .optional()
    .describe('Most severe consequence type for variation features.'),
  clinicalSignificance: z
    .array(z.string().describe('A clinical significance term for this variant.'))
    .optional()
    .describe('Clinical significance terms for variation features (e.g. pathogenic, benign).'),
});

export const ensemblQueryRegion = tool('ensembl_query_region', {
  title: 'Query Genomic Region',
  description:
    'Find genomic features overlapping a chromosomal region: genes, transcripts, variants, regulatory ' +
    'elements, or exons. Returns each feature with its stable ID, type, location, biotype, and name. ' +
    'Useful for "what\'s in this locus?" and for seeding follow-up lookups. Region format is chr:start-end ' +
    '(e.g. 13:32315086-32400268 for the BRCA2 locus). Chromosome names use Ensembl format — no "chr" ' +
    'prefix for vertebrates (use 13 not chr13). The feature parameter defaults to gene only to prevent ' +
    'overwhelming returns — requesting variation in an 85 kb region returns 44,000+ entries. Explicitly ' +
    'include variation, regulatory, transcript, or exon only when needed.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    species: z
      .string()
      .describe(
        'Species in Ensembl internal format (e.g. homo_sapiens, mus_musculus). ' +
          'Use ensembl_list_species to discover valid values.',
      ),
    region: z
      .string()
      .describe(
        'Genomic region in chr:start-end format (e.g. 13:32315086-32400268). ' +
          'Chromosome names use Ensembl format — no "chr" prefix for vertebrates (13, not chr13). ' +
          'For large regions (>100 kb), limit to gene feature type to avoid overwhelming results.',
      ),
    feature: z
      .array(
        z
          .enum(FEATURE_TYPES)
          .describe(
            'A feature type to retrieve: gene, transcript, variation, regulatory, or exon.',
          ),
      )
      .default(['gene'])
      .describe(
        'Feature types to retrieve. Default is gene only. ' +
          'Requesting variation in a large region can return tens of thousands of features. ' +
          'Include variation only for targeted small regions (single gene loci or smaller).',
      ),
    biotype: z
      .string()
      .optional()
      .describe(
        'Optional biotype filter (e.g. protein_coding, lncRNA, SNV). ' +
          'Applied server-side by Ensembl. Not all feature types support biotype filtering.',
      ),
  }),
  output: z.object({
    features: z
      .array(FeatureSchema.describe('A single genomic feature overlapping the queried region.'))
      .describe('Genomic features found in the requested region.'),
    totalCount: z
      .number()
      .describe(
        'Number of features returned. Note: very large regions may return truncated results.',
      ),
    region: z.string().describe('The region queried, as provided.'),
    species: z.string().describe('The species queried.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Warning or guidance about the result set.'),
  },

  errors: [
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region string could not be parsed or contains invalid coordinates.',
      recovery:
        'Use the format chr:start-end (e.g. 13:32315086-32400268). ' +
        'Chromosome names use Ensembl format with no "chr" prefix for vertebrates. ' +
        'Verify coordinates are within the chromosome bounds for the target assembly.',
    },
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The species string was not recognized by Ensembl.',
      recovery:
        'Call ensembl_list_species to discover valid species names in lowercase_underscore format.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Querying region', {
      species: input.species,
      region: input.region,
      features: input.feature,
      biotype: input.biotype,
    });
    const service = getEnsemblService();

    const features = await service
      .queryRegion(input.species, input.region, input.feature, input.biotype, ctx)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /invalid.*region|coordinate|parse/i.test(msg) ||
          /is not a valid start|is not a valid end|is not a valid chr/i.test(msg)
        ) {
          throw ctx.fail('invalid_region', `Invalid region "${input.region}": ${msg}`);
        }
        if (/species|invalid|unrecognized/i.test(msg)) {
          throw ctx.fail('invalid_species', `Species "${input.species}" not recognized.`);
        }
        throw err;
      });

    if (features.length === 0) {
      ctx.enrich.notice(
        `No ${input.feature.join(', ')} features found in ${input.region} for ${input.species}. ` +
          'The region may be intergenic or use a different chromosome naming convention.',
      );
    } else if (features.length > 1000) {
      ctx.enrich.notice(
        `Large result set (${features.length} features). ` +
          'Consider narrowing the region or filtering by biotype to reduce context usage.',
      );
    }
    ctx.enrich.total(features.length);

    return {
      features,
      totalCount: features.length,
      region: input.region,
      species: input.species,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Genomic Region: ${result.species} ${result.region}`);
    lines.push(`**Features found:** ${result.totalCount}\n`);

    if (result.features.length === 0) {
      lines.push('No features found in this region.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const f of result.features) {
      const label = f.name ?? f.id ?? f.featureType;
      lines.push(`### ${label}`);
      if (f.id) lines.push(`**ID:** ${f.id}`);
      lines.push(`**Type:** ${f.featureType}`);
      if (f.biotype) lines.push(`**Biotype:** ${f.biotype}`);
      lines.push(
        `**Location:** ${f.chromosome}:${f.start}-${f.end}${f.strand != null ? ` strand:${f.strand} (${f.strand === -1 ? '-' : '+'})` : ''}`,
      );
      if (f.description) lines.push(`**Description:** ${f.description}`);
      if (f.consequenceType) lines.push(`**Consequence:** ${f.consequenceType}`);
      if (f.clinicalSignificance?.length) {
        lines.push(`**Clinical significance:** ${f.clinicalSignificance.join(', ')}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
