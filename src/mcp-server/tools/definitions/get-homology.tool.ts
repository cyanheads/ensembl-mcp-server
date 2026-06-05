/**
 * @fileoverview Tool to find orthologs and paralogs of a gene across species.
 * @module mcp-server/tools/definitions/get-homology
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { HomologyEntry } from '@/services/ensembl/types.js';

const HOMOLOGY_TYPES = ['orthologues', 'paralogues', 'all'] as const;

const HomologyEntrySchema = z.object({
  targetId: z.string().describe('Ensembl stable ID of the homologous gene in the target species.'),
  targetSpecies: z
    .string()
    .optional()
    .describe('Target species in Ensembl internal format (e.g. mus_musculus).'),
  type: z
    .string()
    .optional()
    .describe(
      'Homology type: ortholog_one2one, ortholog_one2many, ortholog_many2many, ' +
        'paralog_many2many, within_species_paralog, or similar.',
    ),
  percId: z
    .number()
    .optional()
    .describe(
      'Percent identity between the query and target gene sequences (0-100). ' +
        'Higher values indicate more conserved sequences.',
    ),
  percPos: z
    .number()
    .optional()
    .describe(
      'Percent positive (similar) positions in the alignment (0-100). ' +
        'Includes conservative substitutions as well as identical residues.',
    ),
  taxonomyLevel: z
    .string()
    .optional()
    .describe(
      'Last common ancestor taxonomic level for this homology relationship ' +
        '(e.g. Amniota, Vertebrata, Bilateria).',
    ),
});

export const ensemblGetHomology = tool('ensembl_get_homology', {
  title: 'Get Gene Homologs',
  description:
    "Find orthologs and/or paralogs of a gene across species. Returns each homolog's stable ID, species, " +
    'homology type (ortholog_one2one, ortholog_one2many, paralog_many2many, etc.), perc_id (percent identity), ' +
    'perc_pos (percent positives), and taxonomy level. Essential for cross-species research — for example, ' +
    '"what is the mouse equivalent of human TP53?" or "how conserved is BRCA2 across mammals?". ' +
    'Provide either symbol + species or a stable gene ID. Target species can be filtered to a single species ' +
    'or left open to return all available homologs.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    symbol: z
      .string()
      .optional()
      .describe(
        'Gene symbol in the source species (e.g. BRCA2, TP53). ' +
          'Requires species to be set. Cannot be used together with id.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Ensembl stable gene ID (e.g. ENSG00000139618). ' +
          'Use ensembl_lookup_gene to get the stable ID from a symbol. ' +
          'Cannot be used together with symbol.',
      ),
    species: z
      .string()
      .default('homo_sapiens')
      .describe(
        'Source species (the species the query gene belongs to) in Ensembl internal format. ' +
          'Default is homo_sapiens. Use ensembl_list_species to discover valid values.',
      ),
    target_species: z
      .string()
      .optional()
      .describe(
        'Filter to homologs in a single target species (e.g. mus_musculus for mouse). ' +
          'Omit to return homologs across all available species. ' +
          'Use ensembl_list_species to discover valid values.',
      ),
    type: z
      .enum(HOMOLOGY_TYPES)
      .default('orthologues')
      .describe(
        'Type of homologs to return. ' +
          'orthologues: genes related by speciation (cross-species equivalents). ' +
          'paralogues: genes related by duplication (within or across species). ' +
          'all: both orthologs and paralogs.',
      ),
  }),
  output: z.object({
    homologs: z
      .array(
        HomologyEntrySchema.describe(
          'A single homologous gene with its stable ID, species, homology type, and sequence identity metrics.',
        ),
      )
      .describe('Homologous genes found for the query gene.'),
    totalCount: z.number().describe('Total number of homologs returned.'),
    queryId: z.string().describe('The resolved Ensembl gene ID used for the homology query.'),
    querySpecies: z.string().describe('The source species used for the query.'),
    queryType: z.string().describe('The homology type queried (orthologues, paralogues, or all).'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no homologs are found.'),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The gene symbol or stable ID was not found in Ensembl.',
      recovery:
        'Verify the symbol spelling or use ensembl_lookup_gene to get the stable ID first. ' +
        'Confirm the species is correct with ensembl_list_species.',
    },
    {
      reason: 'no_input',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither symbol nor id was provided.',
      recovery: 'Provide either symbol (with species) or a stable Ensembl gene ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting homologs', {
      symbol: input.symbol,
      id: input.id,
      species: input.species,
      targetSpecies: input.target_species,
      type: input.type,
    });
    const service = getEnsemblService();

    if (!input.symbol?.trim() && !input.id?.trim()) {
      throw ctx.fail('no_input', 'Provide either symbol (with species) or a stable gene ID.');
    }

    let queryId: string;
    let homologs: HomologyEntry[];

    if (input.id?.trim()) {
      queryId = input.id.trim();
      homologs = await service
        .getHomologyById(queryId, input.type, input.target_species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(msg)) {
            throw ctx.fail('not_found', `Gene ID "${queryId}" not found in Ensembl.`);
          }
          throw err;
        });
    } else {
      queryId = input.symbol!.trim();
      homologs = await service
        .getHomologyBySymbol(queryId, input.species, input.type, input.target_species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(msg)) {
            throw ctx.fail('not_found', `Gene symbol "${queryId}" not found in ${input.species}.`);
          }
          throw err;
        });
    }

    if (homologs.length === 0) {
      ctx.enrich.notice(
        `No ${input.type} found for "${queryId}" in ${input.species}` +
          (input.target_species ? ` targeting ${input.target_species}` : '') +
          '. Try type=all or remove the target_species filter.',
      );
    }
    ctx.enrich.total(homologs.length);

    return {
      homologs,
      totalCount: homologs.length,
      queryId,
      querySpecies: input.species,
      queryType: input.type,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Homologs of ${result.queryId} (${result.querySpecies})`);
    lines.push(`**Type:** ${result.queryType} | **Found:** ${result.totalCount}\n`);

    if (result.homologs.length === 0) {
      lines.push('No homologs found. Try type=all or remove the target_species filter.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const h of result.homologs) {
      lines.push(`### ${h.targetId}`);
      if (h.targetSpecies) lines.push(`**Species:** ${h.targetSpecies}`);
      if (h.type) lines.push(`**Homology type:** ${h.type}`);
      if (h.percId != null) lines.push(`**Percent identity:** ${h.percId.toFixed(1)}%`);
      if (h.percPos != null) lines.push(`**Percent positives:** ${h.percPos.toFixed(1)}%`);
      if (h.taxonomyLevel) lines.push(`**Last common ancestor:** ${h.taxonomyLevel}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
