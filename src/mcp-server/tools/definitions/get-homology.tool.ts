/**
 * @fileoverview Tool to find orthologs and paralogs of a gene across species.
 * @module mcp-server/tools/definitions/get-homology
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { HomologyEntry } from '@/services/ensembl/types.js';

const HOMOLOGY_TYPES = ['orthologues', 'paralogues', 'all'] as const;

/** Ensembl's rejection of a source or target species it does not know. */
const UNKNOWN_SPECIES = /can not find internal name for species/i;

const HomologyEntrySchema = z.object({
  targetId: z.string().describe('Ensembl stable ID of the homologous gene in the target species.'),
  targetSymbol: z
    .string()
    .optional()
    .describe('Target gene display name, when a bounded secondary lookup resolves it.'),
  targetProteinId: z
    .string()
    .optional()
    .describe('Target translation stable ID. Pass to ensembl_get_sequence with type="protein".'),
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
    'homology type (ortholog_one2one, ortholog_one2many, paralog_many2many, etc.), percId (percent identity), ' +
    'percPos (percent positives), and taxonomy level. Essential for cross-species research — for example, ' +
    '"what is the mouse equivalent of human TP53?" or "how conserved is BRCA2 across mammals?". ' +
    'Provide either symbol + species or a stable gene ID. Target species can be filtered to a single species ' +
    'or left open to return all available homologs. Includes targetProteinId when available for ' +
    'ensembl_get_sequence with type="protein". targetSymbol is best-effort: a secondary gene lookup ' +
    'shares five seconds across the returned rows and the remaining call deadline; missing names never remove homologs.',
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
          'A version suffix (ENSG00000139618.17) is accepted and dropped before the query. ' +
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
          'Default is homo_sapiens. Use ensembl_list_species with nameContains (a genus or common ' +
          'name, e.g. mouse) to find valid values.',
      ),
    target_species: z
      .string()
      .optional()
      .describe(
        'Filter to homologs in a single target species (e.g. mus_musculus for mouse). ' +
          'Omit to return homologs across all available species. ' +
          'Use ensembl_list_species with nameContains (a genus or common name) to find valid values.',
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
      .describe(
        'Guidance when no homologs are found, the list was capped, or symbol enrichment is incomplete.',
      ),
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
      when: 'The gene symbol or stable ID was not found in Ensembl for the source species.',
      recovery:
        'Verify the symbol spelling or use ensembl_lookup_gene to get the stable ID first. ' +
        'Confirm the species with ensembl_list_species, setting nameContains to a genus or common name.',
    },
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The species or target_species string was not recognized by Ensembl.',
      recovery:
        'Find the internal names for species and target_species with ensembl_list_species, setting ' +
        'nameContains to a genus or common name (e.g. mouse) and division for non-vertebrates. ' +
        'Names are lowercase_underscore (mus_musculus, not Mouse).',
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
      throw ctx.fail('no_input', 'Provide either symbol (with species) or a stable gene ID.');
    }
    if (input.id?.trim() && input.symbol?.trim()) {
      throw ctx.fail(
        'conflicting_input',
        'Provide either symbol or id, not both — they may resolve to different genes.',
      );
    }

    const idTrimmed = input.id?.trim();
    const symbolTrimmed = input.symbol?.trim();
    let queryId: string;
    let homologs: HomologyEntry[];

    /** Ensembl quotes the one name it rejected, source or target species. */
    const failOnUnknownSpecies = (msg: string) => {
      if (!UNKNOWN_SPECIES.test(msg)) return;
      const target = input.target_species;
      const [field, name] =
        target && !msg.includes(`'${input.species}'`) && msg.includes(`'${target}'`)
          ? ['target_species', target]
          : ['species', input.species];
      throw ctx.fail('invalid_species', `${field} "${name}" not recognized by Ensembl.`);
    };

    if (idTrimmed) {
      const result = await service
        .getHomologyById(idTrimmed, input.species, input.type, input.target_species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          failOnUnknownSpecies(msg);
          if (/not found|no valid lookup|page not found/i.test(msg)) {
            throw ctx.fail('not_found', `Gene ID "${idTrimmed}" not found in ${input.species}.`);
          }
          throw err;
        });
      homologs = result.homologs;
      // The unversioned stable ID Ensembl answered for; the submitted ID only if it named none.
      queryId = result.resolvedQueryId ?? idTrimmed;
    } else {
      const submittedSymbol = symbolTrimmed ?? '';
      const result = await service
        .getHomologyBySymbol(submittedSymbol, input.species, input.type, input.target_species, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          failOnUnknownSpecies(msg);
          // Ensembl returns {"error":"<species_name>"} for invalid gene symbols in homology endpoint
          if (/not found|no valid lookup/i.test(msg) || msg === input.species) {
            throw ctx.fail(
              'not_found',
              `Gene symbol "${submittedSymbol}" not found in ${input.species}.`,
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
    const names = await service.getHomologyTargetSymbols(
      returned.map((h) => h.targetId),
      ctx,
    );
    const enriched = returned.map((h) => {
      const name = names.get(h.targetId);
      return name ? { ...h, targetSymbol: name } : h;
    });
    const missingNames = enriched.filter((h) => !h.targetSymbol).length;
    const fragments: string[] = [];

    if (returned.length === 0) {
      fragments.push(
        `No ${input.type} found for "${queryId}" in ${input.species}` +
          (input.target_species ? ` targeting ${input.target_species}` : '') +
          '. Try type=all or remove the target_species filter.',
      );
    } else if (returned.length < availableCount) {
      fragments.push(
        `Showing ${returned.length} of ${availableCount} homologs. ` +
          'Raise max_results (0 returns all) or set target_species to narrow to one species.',
      );
    }
    if (missingNames) {
      fragments.push(
        `Target symbols are unavailable for ${missingNames} returned homologs: lookup failed, exhausted its budget, or supplied no name. ` +
          'All homologs are retained; use ensembl_lookup_gene with their targetId to look up missing names.',
      );
    }
    if (returned.length < availableCount) {
      ctx.enrich.truncated({
        shown: returned.length,
        cap: input.max_results,
        guidance: fragments.join(' '),
      });
    } else if (fragments.length) {
      ctx.enrich.notice(fragments.join(' '));
    }

    return {
      homologs: enriched,
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
      if (h.targetSymbol) lines.push(`**Gene symbol:** ${h.targetSymbol}`);
      if (h.targetProteinId) lines.push(`**Protein ID:** ${h.targetProteinId}`);
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
