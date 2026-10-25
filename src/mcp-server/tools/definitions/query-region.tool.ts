/**
 * @fileoverview Tool to find genomic features overlapping a chromosomal region.
 * @module mcp-server/tools/definitions/query-region
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  isMitochondrionAlias,
  isReversed,
  leadingChromosome,
  mentionsInOrder,
  mitochondrionMessage,
  parseRegion,
  reversedMessage,
} from '@/mcp-server/tools/region-grammar.js';
import { renderHeading } from '@/mcp-server/tools/render-heading.js';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const FEATURE_TYPES = ['gene', 'transcript', 'variation', 'regulatory', 'exon'] as const;

/** Ensembl's rejection of an unknown species; it quotes the name it could not find. */
const UNKNOWN_SPECIES = /can not find internal name for species/i;

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
  parentId: z
    .string()
    .optional()
    .describe(
      'Parent transcript ID (ENST…) for exon features. An exon is reported once per parent ' +
        'transcript it belongs to, so the same exon ID can appear on multiple rows that differ ' +
        'only by this field — not duplicates.',
    ),
  rank: z
    .number()
    .optional()
    .describe('Position (1-based) of an exon within its parent transcript.'),
});

export const ensemblQueryRegion = tool('ensembl_query_region', {
  title: 'Query Genomic Region',
  description:
    'Find genomic features overlapping a chromosomal region: genes, transcripts, variants, regulatory ' +
    'elements, or exons. Returns each feature with its stable ID, type, location, biotype, and name, ' +
    'plus the genome assembly the coordinates are on. ' +
    'Useful for "what\'s in this locus?" and for seeding follow-up lookups. Region format is chr:start-end ' +
    'with species set (e.g. 13:32315086-32400268 for the BRCA2 locus), or species:chr:start-end ' +
    '(e.g. homo_sapiens:13:32315086-32400268), spanning at most 5,000,000 bases. Ensembl normalizes ' +
    'chromosome names and canonical vertebrate output omits the chr prefix (13, not chr13); a chr-prefixed ' +
    'name like chr13 is also accepted. The feature parameter defaults to gene only — requesting ' +
    'variation in an 85 kb region matches 44,000+ entries. Explicitly include variation, regulatory, ' +
    'transcript, or exon only when needed. The response returns up to max_results features (default 100) ' +
    'while totalCount always reports the full count; set max_results to 0 for every feature, or query a ' +
    'smaller region to see a different slice. Exon rows carry the parent transcript ID, so the same exon ' +
    'appears once per transcript it belongs to.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    species: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Species in Ensembl internal format (e.g. homo_sapiens, mus_musculus). Required for a bare ' +
          'chr:start-end region; for the species:chr:start-end form the species in region takes ' +
          'precedence and this field is ignored. Use ensembl_list_species with nameContains (a genus ' +
          'or common name, e.g. mouse) to find valid values.',
      ),
    region: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Genomic region as chr:start-end with species set (e.g. 13:32315086-32400268), or ' +
          'species:chr:start-end (e.g. homo_sapiens:13:32315086-32400268), with start at or below ' +
          'end. Ensembl serves at most 5,000,000 bases per region; split a larger area into smaller ' +
          'windows. Ensembl normalizes chromosome names and canonical vertebrate output omits the chr ' +
          'prefix (13, not chr13); a chr-prefixed name like chr13 is also accepted. The mitochondrion ' +
          'is MT in vertebrates, mitochondrion_genome in Drosophila, and MtDNA in C. elegans; M and ' +
          'chrM are accepted only where Ensembl resolves them to the mitochondrion (Drosophila, for ' +
          'one) and otherwise fail as invalid_region naming the mitochondrion of the species. ' +
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
      .min(1, `Provide at least one feature type: ${FEATURE_TYPES.join(', ')}.`)
      .default(['gene'])
      .describe(
        'Feature types to retrieve — at least one. Default is gene only. ' +
          'Requesting variation in a large region can match tens of thousands of features. ' +
          'Include variation only for targeted small regions (single gene loci or smaller).',
      ),
    biotype: z
      .string()
      .optional()
      .describe(
        'Optional biotype filter (e.g. protein_coding, lncRNA, SNV). ' +
          'Case-sensitive (lncRNA, not lncrna); remove the filter to inspect all matching feature types. ' +
          'Applied server-side by Ensembl. Not all feature types support biotype filtering.',
      ),
    max_results: z
      .number()
      .int()
      .min(0)
      .default(100)
      .describe(
        'Maximum number of features to return. A gene-length region can hold tens of thousands of ' +
          'variation features; the default keeps the response compact. Set to 0 to return every ' +
          'feature uncapped. totalCount always reports the true number found before this cap.',
      ),
  }),
  output: z.object({
    features: z
      .array(FeatureSchema.describe('A single genomic feature overlapping the queried region.'))
      .describe(
        'Genomic features found in the requested region, capped to max_results. ' +
          'totalCount reports the full count found before the cap.',
      ),
    totalCount: z
      .number()
      .describe(
        'Total number of features found in the region before the max_results cap. ' +
          'Exceeds the returned features count when the list was capped.',
      ),
    region: z
      .string()
      .describe('The region queried, as provided minus any species prefix (reported as species).'),
    species: z
      .string()
      .describe(
        "The species queried: the region's species prefix when it has one, otherwise the species field.",
      ),
    assemblyName: z
      .string()
      .optional()
      .describe(
        'Genome assembly the coordinates are on (e.g. GRCh38). Omitted only when it could not be ' +
          'resolved, in which case the notice says so.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance about the result set: empty, large, capped, or missing assembly.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the feature list was capped at max_results.'),
    shown: z.number().optional().describe('Number of features returned after the max_results cap.'),
    cap: z.number().optional().describe('The max_results limit applied to the feature list.'),
  },

  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
  },

  errors: [
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when:
        'The region string could not be parsed, has its start greater than its end, names the ' +
        'mitochondrion M or chrM where Ensembl resolves that to another region or none, contains ' +
        'coordinates outside the sequence region, or spans more than the 5,000,000-base maximum.',
      recovery:
        'Use the format [species:]chr:start-end (e.g. 13:32315086-32400268) with start at or below ' +
        'end, spanning at most 5,000,000 bases; split a larger area into smaller windows. ' +
        'Chromosome names normalize either way — canonical vertebrate names omit the chr prefix ' +
        '(13, not chr13), but a chr-prefixed name is also accepted; the mitochondrion is MT in ' +
        'vertebrates, mitochondrion_genome in Drosophila, and MtDNA in C. elegans — use that name ' +
        'where M or chrM is rejected. ' +
        'Verify coordinates are within the chromosome bounds for the target assembly.',
    },
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: "The species (the species field or the region's species prefix) was not recognized by Ensembl.",
      recovery:
        'Find the internal name with ensembl_list_species, setting nameContains to a genus or common ' +
        'name (e.g. mouse) and division for non-vertebrates. Names are lowercase_underscore ' +
        '(mus_musculus, not Mouse).',
    },
    {
      reason: 'missing_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A bare chr:start-end region was given without a species.',
      recovery:
        'Set species (e.g. homo_sapiens) alongside the chr:start-end region, or write the region ' +
        'as species:chr:start-end.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Querying region', {
      species: input.species,
      region: input.region,
      features: input.feature,
      biotype: input.biotype,
      maxResults: input.max_results,
    });
    const service = getEnsemblService();

    // A species prefix names the organism the coordinates belong to, so it wins over the
    // species field, and Ensembl receives the region without it. Two shapes are rejected
    // before the request; everything else is forwarded as written, including forms the
    // grammar does not take (comma-grouped coordinates, a start-only MT:16000), which
    // Ensembl serves or rejects itself.
    const parsed = parseRegion(input.region);
    const species = parsed?.species ?? input.species;
    const region = parsed?.region ?? input.region;
    if (!species) {
      throw ctx.fail(
        'missing_species',
        `Region ${input.region} needs a species — set species (e.g. homo_sapiens) or write the ` +
          'region as species:chr:start-end.',
      );
    }
    if (parsed && isReversed(parsed)) {
      throw ctx.fail('invalid_region', reversedMessage(input.region, parsed));
    }
    const chromosome = parsed?.chromosome ?? leadingChromosome(region);
    if (isMitochondrionAlias(chromosome)) {
      const check = await service
        .checkMitochondrionAlias(species, chromosome, ctx)
        .catch((err: unknown) => {
          if (UNKNOWN_SPECIES.test(err instanceof Error ? err.message : String(err))) {
            throw ctx.fail('invalid_species', `Species "${species}" not recognized.`);
          }
          throw err;
        });
      if (!check.resolves) {
        throw ctx.fail(
          'invalid_region',
          mitochondrionMessage(region, chromosome, species, check.mitochondrion),
        );
      }
    }

    const features = await service
      .queryRegion(species, region, input.feature, input.biotype, ctx)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          mentionsInOrder(msg, 'invalid', 'region') ||
          /coordinate|parse/i.test(msg) ||
          /is not a valid (?:start|end|chr|strand)/i.test(msg) ||
          /no slice found|cannot request a slice|could not decode region/i.test(msg) ||
          /maximum allowed length/i.test(msg)
        ) {
          throw ctx.fail('invalid_region', `Invalid region "${input.region}": ${msg}`);
        }
        if (/species|invalid|unrecognized/i.test(msg)) {
          throw ctx.fail('invalid_species', `Species "${species}" not recognized.`);
        }
        throw err;
      });

    // Ensembl returns the full overlap set with no paging; cap post-fetch so wide
    // regions stay compact by default. totalCount stays the true pre-cap count
    // (max_results = 0 disables the cap).
    const totalCount = features.length;
    const returned = input.max_results > 0 ? features.slice(0, input.max_results) : features;

    // Every overlap row type except regulatory carries its assembly, so read it from
    // the full set at no request cost; only an empty or regulatory-only result needs
    // the species-default lookup. A failed lookup degrades to a notice, but a
    // cancelled request still fails.
    const assemblyName =
      features.find((f) => f.assemblyName)?.assemblyName ??
      (await service.getDefaultAssemblyName(species, ctx).catch((err: unknown) => {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('Assembly lookup failed', {
          species,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }));

    // ctx.enrich.notice is last-wins, so every applicable fragment composes into ONE string.
    const fragments: string[] = [];
    if (totalCount === 0) {
      fragments.push(
        `No ${input.feature.join(', ')} features found in ${region} for ${species}. ` +
          (input.biotype
            ? `The biotype filter "${input.biotype}" may exclude matching features. ` +
              'Biotypes are case-sensitive (protein_coding, lncRNA). Remove the biotype filter to inspect the region. '
            : 'The region may be intergenic, or the coordinates may not cover the intended locus. ') +
          'Use ensembl_lookup_gene to confirm the locus coordinates.',
      );
    }
    const capped = returned.length < totalCount;
    if (capped) {
      fragments.push(
        `Showing ${returned.length} of ${totalCount} features. ` +
          'Raise max_results (0 returns all) or query a smaller region for the rest.',
      );
    }
    if (totalCount > 1000) {
      fragments.push(
        `Large result set (${totalCount} features). ` +
          'Consider narrowing the region or filtering by biotype to reduce context usage.',
      );
    }
    if (!assemblyName) {
      fragments.push(
        `The assembly for ${species} could not be resolved, so assemblyName is omitted; ` +
          'ensembl_lookup_gene reports the assembly for any gene in this region.',
      );
    }
    if (fragments.length > 0) {
      const guidance = fragments.join(' ');
      if (capped) {
        ctx.enrich.truncated({ shown: returned.length, cap: input.max_results, guidance });
      } else {
        ctx.enrich.notice(guidance);
      }
    }

    return {
      features: returned,
      totalCount,
      region,
      species,
      ...(assemblyName && { assemblyName }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(renderHeading(2, `Genomic Region: ${result.species} ${result.region}`));
    if (result.assemblyName)
      lines.push(`**Assembly:** ${escapeMarkdownInline(result.assemblyName)}`);
    const shown = result.features.length;
    const found =
      result.totalCount > shown ? `${shown} of ${result.totalCount}` : `${result.totalCount}`;
    lines.push(`**Features found:** ${found}\n`);

    if (result.features.length === 0) {
      lines.push('No features found in this region.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const f of result.features) {
      const label = f.name ?? f.id ?? f.featureType;
      lines.push(renderHeading(3, label));
      if (f.id) lines.push(`**ID:** ${escapeMarkdownInline(f.id)}`);
      lines.push(`**Type:** ${escapeMarkdownInline(f.featureType)}`);
      if (f.biotype) lines.push(`**Biotype:** ${escapeMarkdownInline(f.biotype)}`);
      lines.push(
        `**Location:** ${escapeMarkdownInline(f.chromosome)}:${f.start}-${f.end}${f.strand != null ? ` strand:${f.strand} (${f.strand === -1 ? '-' : '+'})` : ''}`,
      );
      if (f.parentId) {
        lines.push(
          `**Parent transcript:** ${escapeMarkdownInline(f.parentId)}${f.rank != null ? ` (exon rank ${f.rank})` : ''}`,
        );
      }
      if (f.description) lines.push(`**Description:** ${escapeMarkdownInline(f.description)}`);
      if (f.consequenceType)
        lines.push(`**Consequence:** ${escapeMarkdownInline(f.consequenceType)}`);
      if (f.clinicalSignificance?.length) {
        lines.push(
          `**Clinical significance:** ${escapeMarkdownInline(f.clinicalSignificance.join(', '))}`,
        );
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
