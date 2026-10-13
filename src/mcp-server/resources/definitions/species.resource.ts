/**
 * @fileoverview Resources exposing the Ensembl species catalog — the endpoint
 * default division (vertebrates) at `ensembl://species` and a division-filtered
 * view at the `ensembl://species/{division}` template.
 * @module mcp-server/resources/definitions/species
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const DIVISION_VALUES = [
  'EnsemblVertebrates',
  'EnsemblPlants',
  'EnsemblFungi',
  'EnsemblMetazoa',
  'EnsemblProtists',
] as const;

/** Species per resource body; the ensembl_list_species tool pages past it. */
const RESOURCE_SPECIES_CAP = 50;

/**
 * Fetch the species catalog (optionally filtered to one division) and return the
 * first {@link RESOURCE_SPECIES_CAP} by internal name, with the true total and a
 * notice routing the remainder to ensembl_list_species.
 */
async function loadSpeciesCatalog(division: string | undefined, ctx: Context) {
  const service = getEnsemblService();
  const species = await service.listSpecies(division, ctx);
  species.sort((a, b) => a.name.localeCompare(b.name));
  const totalCount = species.length;
  const page = species.slice(0, RESOURCE_SPECIES_CAP);
  const truncated = page.length < totalCount;
  const divisionArg = division ? `division "${division}"` : 'division omitted (endpoint default)';
  return {
    species: page,
    totalCount,
    shown: page.length,
    truncated,
    ...(truncated && {
      notice:
        `Showing the first ${page.length} of ${totalCount} species by internal name. For the rest, ` +
        `call ensembl_list_species with ${divisionArg}, offset ${page.length}, and max_results ` +
        '(0 returns every remaining species), or use its nameContains to find a species by name.',
    }),
  };
}

export const ensemblSpeciesResource = resource('ensembl://species', {
  name: 'Ensembl Species',
  description:
    'Ensembl species catalog for the endpoint default division — internal name, display name, assembly, ' +
    'taxon ID, and division. On the default GRCh38 endpoint this is the vertebrate division (~356 species). ' +
    'Returns the first 50 species by internal name with totalCount, shown, and truncated; when truncated, ' +
    'a notice points to the ensembl_list_species tool (offset, max_results) for the rest. ' +
    'For a specific division read ensembl://species/{division} (e.g. ensembl://species/EnsemblPlants); ' +
    'the tool also filters by name.',
  mimeType: 'application/json',
  params: z.object({}),

  async handler(_params, ctx) {
    ctx.log.debug('Fetching species resource (endpoint default division)');
    return await loadSpeciesCatalog(undefined, ctx);
  },

  list: async () => ({
    resources: [
      {
        uri: 'ensembl://species',
        name: 'Ensembl Species',
        description: 'Ensembl species for the endpoint default division (vertebrates by default)',
        mimeType: 'application/json',
      },
    ],
  }),
});

export const ensemblSpeciesByDivisionResource = resource('ensembl://species/{division}', {
  name: 'Ensembl Species by Division',
  description:
    'Ensembl-supported species within a single division (EnsemblVertebrates, EnsemblPlants, EnsemblFungi, ' +
    'EnsemblMetazoa, or EnsemblProtists) — internal name, display name, assembly, taxon ID, and division. ' +
    'Returns the first 50 species by internal name with totalCount, shown, and truncated; when truncated, ' +
    'a notice points to the ensembl_list_species tool (division, offset, max_results) for the rest. ' +
    'Read ensembl://species for the endpoint default division (vertebrates); the tool also filters by name.',
  mimeType: 'application/json',
  params: z.object({
    division: z
      .enum(DIVISION_VALUES)
      .describe(
        'Ensembl division to filter to. One of EnsemblVertebrates, EnsemblPlants, EnsemblFungi, ' +
          'EnsemblMetazoa, EnsemblProtists.',
      ),
  }),

  async handler(params, ctx) {
    ctx.log.debug('Fetching species resource by division', { division: params.division });
    return await loadSpeciesCatalog(params.division, ctx);
  },

  list: async () => ({
    resources: DIVISION_VALUES.map((division) => ({
      uri: `ensembl://species/${division}`,
      name: `${division} species`,
      description: `Ensembl-supported species in the ${division} division`,
      mimeType: 'application/json',
    })),
  }),
});
