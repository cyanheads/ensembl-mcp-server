/**
 * @fileoverview Resource exposing Ensembl gene records by stable ID.
 * @module mcp-server/resources/definitions/gene
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

export const ensemblGeneResource = resource('ensembl://gene/{id}', {
  name: 'Ensembl Gene',
  description:
    'Gene record by Ensembl stable ID (ENSG…). Returns location, biotype, description, and transcript list. ' +
    'Stable, injectable context for multi-step workflows. ' +
    'Use ensembl_lookup_gene to resolve a gene symbol to the stable ID first.',
  mimeType: 'application/json',
  params: z.object({
    id: z
      .string()
      .describe(
        'Ensembl gene stable ID (ENSG…). ' +
          'Version suffix is optional — omitting it resolves to the current version. ' +
          'Example: ENSG00000139618 or ENSG00000139618.7',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The gene stable ID was not found in Ensembl.',
      recovery:
        'Verify the ID format (ENSG followed by 11 digits, optional .version suffix). ' +
        'Use ensembl_lookup_gene to resolve a symbol to a current stable ID.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Fetching gene resource', { id: params.id });
    const service = getEnsemblService();

    const gene = await service.lookupGeneById(params.id, true, ctx).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) {
        throw ctx.fail('not_found', `Gene ${params.id} not found in Ensembl.`);
      }
      throw err;
    });

    return gene;
  },

  list: async () => ({
    resources: [
      {
        uri: 'ensembl://gene/ENSG00000139618',
        name: 'BRCA2 (homo_sapiens)',
        description: 'Example: BRCA2 breast cancer susceptibility gene',
        mimeType: 'application/json',
      },
      {
        uri: 'ensembl://gene/ENSG00000141510',
        name: 'TP53 (homo_sapiens)',
        description: 'Example: Tumor protein p53',
        mimeType: 'application/json',
      },
    ],
  }),
});
