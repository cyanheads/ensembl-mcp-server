/**
 * @fileoverview Tool to list Ensembl-supported species with display names, assemblies, and taxon IDs.
 * @module mcp-server/tools/definitions/list-species
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
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
    'input format every other Ensembl tool expects. Filter by division to limit results; use nameContains ' +
    'to find a species by partial name match. Returns the full species catalog when no filters are applied ' +
    '(EnsemblVertebrates has ~250 species; all divisions combined have ~1,000+).',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    division: z
      .enum(DIVISION_VALUES)
      .optional()
      .describe(
        'Filter to a specific Ensembl division. ' +
          'EnsemblVertebrates includes human, mouse, zebrafish, and other vertebrates. ' +
          'EnsemblPlants covers crop and model plant genomes. ' +
          'EnsemblFungi, EnsemblMetazoa, EnsemblProtists cover non-vertebrate model organisms. ' +
          'Omit to return all divisions.',
      ),
    nameContains: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter applied locally after fetching. ' +
          'Matches against species name, display name, and common name. ' +
          'Example: "sapiens" matches homo_sapiens; "mouse" matches mus_musculus.',
      ),
  }),
  output: z.object({
    species: z
      .array(SpeciesItemSchema.describe('A single Ensembl species entry.'))
      .describe('Species matching the filter criteria, sorted by internal name.'),
    totalCount: z.number().describe('Total number of matching species after local filtering.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when the filter matches no species.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Listing species', { division: input.division, nameContains: input.nameContains });
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
          `No species matched "${input.nameContains}". ` +
            'Call ensembl_list_species without nameContains to browse all species.',
        );
      }
    }

    species.sort((a, b) => a.name.localeCompare(b.name));
    ctx.enrich.total(species.length);

    return {
      species: species.map((s) => ({
        name: s.name,
        ...(s.displayName && { displayName: s.displayName }),
        ...(s.commonName && { commonName: s.commonName }),
        ...(s.taxonId && { taxonId: s.taxonId }),
        ...(s.assembly && { assembly: s.assembly }),
        ...(s.division && { division: s.division }),
      })),
      totalCount: species.length,
    };
  },

  format: (result) => {
    if (result.species.length === 0) {
      return [{ type: 'text', text: 'No matching species found.' }];
    }
    const lines: string[] = [`## Ensembl Species (${result.totalCount} total)\n`];
    for (const s of result.species) {
      const label = s.displayName ?? s.name;
      const common = s.commonName ? ` (${s.commonName})` : '';
      lines.push(`**${label}**${common}`);
      lines.push(`- Internal name: \`${s.name}\``);
      if (s.assembly) lines.push(`- Assembly: ${s.assembly}`);
      if (s.taxonId) lines.push(`- Taxon ID: ${s.taxonId}`);
      if (s.division) lines.push(`- Division: ${s.division}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
