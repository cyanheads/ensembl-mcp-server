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
          'Species defaults to homo_sapiens; set species for other organisms. ' +
          'Cannot be combined with id.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Ensembl stable gene ID (e.g. ENSG00000139618). ' +
          'Use ensembl_lookup_gene to get the stable ID from a symbol. ' +
          'Cannot be combined with symbol.',
      ),
    species: z
      .string()
      .trim()
      .min(1)
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
    max_results: z
      .number()
      .int()
      .min(0)
      .default(25)
      .describe(
        'Maximum number of homologs to return. Broad orthology queries ' +
          '(e.g. BRCA2 across all species) can return 150+ homologs; the default keeps ' +
          'responses focused. Set to 0 to return every homolog uncapped. ' +
          'totalCount always reports the true number available before this cap.',
      ),
  }),
  output: z.object({
    homologs: z
      .array(
        HomologyEntrySchema.describe(
          'A single homologous gene with its stable ID, species, homology type, and sequence identity metrics.',
        ),
      )
      .describe(
        'Homologous genes found for the query gene, capped to max_results. ' +
          'totalCount reports the full count available before the cap.',
      ),
    totalCount: z
      .number()
      .describe(
        'Total number of homologs available before the max_results cap. ' +
          'Exceeds the returned homologs count when the list was capped.',
      ),
    queryId: z.string().describe('The resolved Ensembl gene ID used for the homology query.'),
    querySpecies: z.string().describe('The source species used for the query.'),
    queryType: z.string().describe('The homology type queried (orthologues, paralogues, or all).'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when no homologs are found or the list was capped.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the homolog list was capped at max_results.'),
    shown: z.number().optional().describe('Number of homologs returned after the max_results cap.'),
    cap: z.number().optional().describe('The max_results limit applied to the homolog list.'),
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
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither symbol nor id was provided.',
      recovery: 'Provide either symbol (with species) or a stable Ensembl gene ID.',
    },
    {
      reason: 'conflicting_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both symbol and id were provided.',
      recovery:
        'Provide exactly one: a gene symbol (with optional species) or a stable Ensembl gene ID.',
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
      throw ctx.fail('no_input', 'Provide either symbol (with species) or a stable gene ID.', {
        ...ctx.recoveryFor('no_input'),
      });
    }
    if (input.id?.trim() && input.symbol?.trim()) {
      throw ctx.fail(
        'conflicting_input',
        'Provide either symbol or id, not both — they may resolve to different genes.',
        { ...ctx.recoveryFor('conflicting_input') },
      );
    }

    const idTrimmed = input.id?.trim();
    const symbolTrimmed = input.symbol?.trim();
    let queryId: string;
    let homologs: HomologyEntry[];

    if (idTrimmed) {
      const result = await service
        .getHomologyById(idTrimmed, input.species, input.type, input.target_species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found|no valid lookup|page not found/i.test(msg)) {
            throw ctx.fail('not_found', `Gene ID "${idTrimmed}" not found in Ensembl.`, {
              ...ctx.recoveryFor('not_found'),
            });
          }
          throw err;
        });
      homologs = result.homologs;
      // Prefer the stable ID the upstream resolved the query to; fall back to the submitted ID.
      queryId = result.resolvedQueryId ?? idTrimmed;
    } else {
      const submittedSymbol = symbolTrimmed ?? '';
      const result = await service
        .getHomologyBySymbol(submittedSymbol, input.species, input.type, input.target_species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Ensembl returns {"error":"<species_name>"} for invalid gene symbols in homology endpoint
          if (/not found|no valid lookup/i.test(msg) || msg === input.species) {
            throw ctx.fail(
              'not_found',
              `Gene symbol "${submittedSymbol}" not found in ${input.species}.`,
              { ...ctx.recoveryFor('not_found') },
            );
          }
          throw err;
        });
      homologs = result.homologs;
      // Surface the resolved Ensembl stable gene ID rather than echoing the symbol (#6);
      // fall back to the submitted symbol only when the response carried no data entry.
      queryId = result.resolvedQueryId ?? submittedSymbol;
    }

    // Ensembl returns the full homolog set; cap post-fetch so broad orthology
    // queries stay compact by default. totalCount stays the true available count
    // so a caller is never misled about completeness (max_results = 0 disables).
    const availableCount = homologs.length;
    const returned = input.max_results > 0 ? homologs.slice(0, input.max_results) : homologs;

    if (returned.length === 0) {
      ctx.enrich.notice(
        `No ${input.type} found for "${queryId}" in ${input.species}` +
          (input.target_species ? ` targeting ${input.target_species}` : '') +
          '. Try type=all or remove the target_species filter.',
      );
    } else if (returned.length < availableCount) {
      ctx.enrich.truncated({
        shown: returned.length,
        cap: input.max_results,
        guidance:
          `Showing ${returned.length} of ${availableCount} homologs. ` +
          'Raise max_results (0 returns all) or set target_species to narrow to one species.',
      });
    }

    return {
      homologs: returned,
      totalCount: availableCount,
      queryId,
      querySpecies: input.species,
      queryType: input.type,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Homologs of ${result.queryId} (${result.querySpecies})`);
    const shown = result.homologs.length;
    const foundLabel =
      result.totalCount > shown ? `${shown} of ${result.totalCount}` : `${result.totalCount}`;
    lines.push(`**Type:** ${result.queryType} | **Found:** ${foundLabel}\n`);

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
