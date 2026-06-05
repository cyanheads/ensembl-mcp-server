/**
 * @fileoverview Resource exposing the Ensembl species catalog.
 * @module mcp-server/resources/definitions/species
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const DIVISION_VALUES = [
  'EnsemblVertebrates',
  'EnsemblPlants',
  'EnsemblFungi',
  'EnsemblMetazoa',
  'EnsemblProtists',
] as const;

export const ensemblSpeciesResource = resource('ensembl://species', {
  name: 'Ensembl Species',
  description:
    'Complete catalog of Ensembl-supported species with internal name, display name, assembly, ' +
    'taxon ID, and division. Addressable reference for tool bootstrapping. ' +
    'Contains ~350 vertebrate species plus additional non-vertebrate divisions. ' +
    'Use this as stable, injectable context when working with unfamiliar species names.',
  mimeType: 'application/json',
  params: z.object({
    division: z
      .enum(DIVISION_VALUES)
      .optional()
      .describe(
        'Filter to a specific Ensembl division. ' + 'Omit to return species from all divisions.',
      ),
  }),

  async handler(params, ctx) {
    ctx.log.debug('Fetching species resource', { division: params.division });
    const service = getEnsemblService();

    const allSpecies = await service.listSpecies(params.division, ctx);
    allSpecies.sort((a, b) => a.name.localeCompare(b.name));

    return {
      species: allSpecies,
      totalCount: allSpecies.length,
    };
  },

  list: async () => ({
    resources: [
      {
        uri: 'ensembl://species',
        name: 'All Ensembl Species',
        description: 'Complete catalog of Ensembl-supported species',
        mimeType: 'application/json',
      },
    ],
  }),
});
