/**
 * @fileoverview Resource exposing Ensembl transcript records by stable ID.
 * @module mcp-server/resources/definitions/transcript
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

export const ensemblTranscriptResource = resource('ensembl://transcript/{id}', {
  name: 'Ensembl Transcript',
  description:
    'Transcript record by Ensembl stable ID (ENST…). Returns parent gene, location, biotype, ' +
    'canonical flag, and length. Use ensembl_lookup_gene with expand_transcripts=true to discover ' +
    'transcript IDs for a given gene, then fetch this resource for stable, injectable context.',
  mimeType: 'application/json',
  params: z.object({
    id: z
      .string()
      .describe(
        'Ensembl transcript stable ID (ENST…). ' +
          'Version suffix is optional — omitting it resolves to the current version. ' +
          'Example: ENST00000380152 or ENST00000380152.8',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The transcript stable ID was not found in Ensembl.',
      recovery:
        'Verify the ID format (ENST followed by 11 digits, optional .version suffix). ' +
        'Use ensembl_lookup_gene with expand_transcripts=true to get transcript IDs.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Fetching transcript resource', { id: params.id });
    const service = getEnsemblService();

    const transcript = await service.lookupTranscript(params.id, ctx).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) {
        throw ctx.fail('not_found', `Transcript ${params.id} not found in Ensembl.`);
      }
      throw err;
    });

    return transcript;
  },

  list: async () => ({
    resources: [
      {
        uri: 'ensembl://transcript/ENST00000380152',
        name: 'BRCA2-201 canonical transcript (homo_sapiens)',
        description: 'Example: canonical BRCA2 transcript',
        mimeType: 'application/json',
      },
    ],
  }),
});
