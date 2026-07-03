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

/** Fetch the species catalog (optionally filtered to one division), sorted by internal name. */
async function loadSpeciesCatalog(division: string | undefined, ctx: Context) {
  const service = getEnsemblService();
  const species = await service.listSpecies(division, ctx);
  species.sort((a, b) => a.name.localeCompare(b.name));
  return { species, totalCount: species.length };
}

export const ensemblSpeciesResource = resource('ensembl://species', {
  name: 'Ensembl Species',
  description:
    'Ensembl species catalog for the endpoint default division — internal name, display name, assembly, ' +
    'taxon ID, and division. On the default GRCh38 endpoint this returns the vertebrate division (~356 species). ' +
    'Stable, injectable context for unfamiliar species names. ' +
    'For a specific division read ensembl://species/{division} (e.g. ensembl://species/EnsemblPlants); ' +
    'the ensembl_list_species tool also filters by division and name.',
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
        name: 'All Ensembl Species',
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
    'Read ensembl://species for the endpoint default division (vertebrates), or use the ensembl_list_species ' +
    'tool to also filter by name.',
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
