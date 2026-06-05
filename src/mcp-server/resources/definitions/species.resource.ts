/**
 * @fileoverview Resource exposing the Ensembl species catalog with pagination.
 * @module mcp-server/resources/definitions/species
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { extractCursor, paginateArray, requestContextService } from '@cyanheads/mcp-ts-core/utils';
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
    'Paginated list of all Ensembl-supported species with internal name, display name, assembly, ' +
    'taxon ID, and division. Addressable reference for tool bootstrapping. ' +
    'Contains ~250 vertebrate species plus additional non-vertebrate divisions. ' +
    'Use this as stable, injectable context when working with unfamiliar species names.',
  mimeType: 'application/json',
  params: z.object({
    cursor: z.string().optional().describe('Opaque pagination cursor from a previous response.'),
    division: z
      .enum(DIVISION_VALUES)
      .optional()
      .describe(
        'Filter to a specific Ensembl division. ' + 'Omit to return species from all divisions.',
      ),
  }),

  async handler(params, ctx) {
    ctx.log.debug('Fetching species resource', {
      cursor: params.cursor,
      division: params.division,
    });
    const service = getEnsemblService();

    const allSpecies = await service.listSpecies(params.division, ctx);
    allSpecies.sort((a, b) => a.name.localeCompare(b.name));

    const cursor = extractCursor({ ...(params.cursor && { cursor: params.cursor }) });
    const reqCtx = requestContextService.createRequestContext({
      operation: 'ensembl-species-resource',
      parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
    });
    const page = paginateArray(allSpecies, cursor, 50, 500, reqCtx);

    return {
      species: page.items,
      nextCursor: page.nextCursor,
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
