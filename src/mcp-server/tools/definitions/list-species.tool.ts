/**
 * @fileoverview Tool to list Ensembl-supported species with display names, assemblies, and taxon IDs.
 * @module mcp-server/tools/definitions/list-species
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const DIVISION_VALUES = [
  'EnsemblVertebrates',
  'EnsemblPlants',
  'EnsemblFungi',
  'EnsemblMetazoa',
  'EnsemblProtists',
] as const;

const SpeciesItemSchema = z.object({
  name: z
    .string()
    .describe(
      'Ensembl internal species name in lowercase_underscore format (e.g. homo_sapiens, mus_musculus). ' +
        'This is the value to pass as the species parameter in all other Ensembl tools.',
    ),
  displayName: z
    .string()
    .optional()
    .describe('Human-readable scientific name (e.g. Homo sapiens).'),
  commonName: z.string().optional().describe('Common name (e.g. Human, Mouse).'),
  taxonId: z.string().optional().describe('NCBI taxonomy ID for this species.'),
  assembly: z.string().optional().describe('Current genome assembly name (e.g. GRCh38).'),
  division: z
    .string()
    .optional()
    .describe('Ensembl division this species belongs to (e.g. EnsemblVertebrates, EnsemblPlants).'),
});

export const ensemblListSpecies = tool('ensembl_list_species', {
  title: 'List Ensembl Species',
  description:
    'List species supported by Ensembl with display name, common name, assembly, taxon ID, and division. ' +
    'Required discovery step — species names like homo_sapiens are opaque to non-biologists and are the ' +
    'input format every other Ensembl tool expects. Use nameContains to find a species by partial name ' +
    'match; filter by division to select one. With no division, lists the endpoint default division — ' +
    'the vertebrates (~356 species on the default GRCh38 endpoint). Species are sorted by internal name ' +
    'and returned max_results at a time (default 50); totalCount reports every match, and when more ' +
    'follow, nextOffset is the offset for the next page.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    division: z
      .enum(DIVISION_VALUES)
      .optional()
      .describe(
        'Filter to a specific Ensembl division. ' +
          'EnsemblVertebrates includes human, mouse, zebrafish, and other vertebrates. ' +
          'EnsemblPlants covers crop and model plant genomes. ' +
          'EnsemblFungi, EnsemblMetazoa, EnsemblProtists cover non-vertebrate model organisms. ' +
          'Omit to return the endpoint default division (vertebrates).',
      ),
    nameContains: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter applied locally after fetching. ' +
          'Matches against species name, display name, and common name. ' +
          'Example: "sapiens" matches homo_sapiens; "mouse" matches mus_musculus.',
      ),
    max_results: z
      .number()
      .int()
      .min(0)
      .default(50)
      .describe(
        'Maximum number of species to return, counted from offset. Default 50. ' +
          'Set to 0 to return every matching species from offset to the end, uncapped. ' +
          'totalCount always reports the full number of matches before this cap.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        '0-based position in the name-sorted matches where the returned page starts. Default 0. ' +
          'Pass nextOffset from a previous response to fetch the following page; an offset at or ' +
          'past totalCount returns no species.',
      ),
  }),
  output: z.object({
    species: z
      .array(SpeciesItemSchema.describe('A single Ensembl species entry.'))
      .describe(
        'Species matching the filter criteria, sorted by internal name: at most max_results entries ' +
          'starting at offset.',
      ),
    totalCount: z
      .number()
      .describe(
        'Total number of matching species after local filtering, before offset and max_results. ' +
          'Exceeds the returned species count when the list was paged.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the first species after this page — pass it as offset to fetch the next page. ' +
          'Present only when more species follow.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the filter matches no species, the offset is past the end, or more species ' +
          'follow this page.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more matching species follow this page; request nextOffset to continue.',
      ),
    shown: z.number().optional().describe('Number of species returned on this page.'),
    cap: z.number().optional().describe('The max_results limit applied to this page.'),
  },

  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
  },

  async handler(input, ctx) {
    ctx.log.info('Listing species', {
      division: input.division,
      nameContains: input.nameContains,
      offset: input.offset,
      maxResults: input.max_results,
    });
    const service = getEnsemblService();
    let species = await service.listSpecies(input.division, ctx);

    if (input.nameContains?.trim()) {
      const q = input.nameContains.toLowerCase();
      const tokens = q.split(/\s+/).filter(Boolean);
      species = species.filter((s) => {
        const hay = [s.name, s.displayName, s.commonName].filter(Boolean).join(' ').toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
      if (species.length === 0) {
        ctx.enrich.notice(
          `No species matched "${input.nameContains}"${input.division ? ` in ${input.division}` : ''}. ` +
            'Try a shorter fragment, such as a genus or common name, or ' +
            (input.division
              ? 'another division.'
              : 'set division: without it only vertebrates are searched.'),
        );
      }
    }

    // Upstream /info/species order varies per call; sort before slicing so pages are repeatable.
    species.sort((a, b) => a.name.localeCompare(b.name));
    const totalCount = species.length;
    ctx.enrich.total(totalCount);

    const end = input.max_results > 0 ? input.offset + input.max_results : totalCount;
    const page = species.slice(input.offset, end);
    const pageEnd = input.offset + page.length;
    const nextOffset = pageEnd < totalCount ? pageEnd : undefined;

    if (totalCount > 0 && input.offset >= totalCount) {
      ctx.enrich.notice(
        `No species returned: offset ${input.offset} is at or past the end of the ${totalCount} ` +
          `matching species. Request an offset below ${totalCount}, or omit offset for the first page.`,
      );
    } else if (nextOffset !== undefined) {
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.max_results,
        guidance:
          `Showing ${page.length} of ${totalCount} species from offset ${input.offset}. ` +
          `Call again with offset ${nextOffset} (nextOffset) for the next page, set max_results to 0 ` +
          'for every remaining species, or narrow with nameContains.',
      });
    }

    return { species: page, totalCount, ...(nextOffset !== undefined && { nextOffset }) };
  },

  format: (result) => {
    const shown = result.species.length;
    if (shown === 0) {
      const text =
        result.totalCount === 0
          ? 'No matching species found.'
          : `No species on this page — ${result.totalCount} species match in total.`;
      return [{ type: 'text', text }];
    }
    const countLabel =
      shown < result.totalCount ? `${shown} of ${result.totalCount}` : `${result.totalCount} total`;
    const lines: string[] = [`## Ensembl Species (${countLabel})\n`];
    if (result.nextOffset !== undefined) lines.push(`**Next offset:** ${result.nextOffset}\n`);
    for (const s of result.species) {
      const label = s.displayName ?? s.name;
      const common = s.commonName ? ` (${escapeMarkdownInline(s.commonName)})` : '';
      lines.push(`**${escapeMarkdownInline(label)}**${common}`);
      lines.push(`- Internal name: ${escapeMarkdownInline(s.name)}`);
      if (s.assembly) lines.push(`- Assembly: ${escapeMarkdownInline(s.assembly)}`);
      if (s.taxonId) lines.push(`- Taxon ID: ${escapeMarkdownInline(s.taxonId)}`);
      if (s.division) lines.push(`- Division: ${escapeMarkdownInline(s.division)}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
