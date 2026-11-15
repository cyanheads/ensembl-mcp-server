/**
 * @fileoverview Resource exposing Ensembl transcript records by stable ID.
 * @module mcp-server/resources/definitions/transcript
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { OtherObject } from '@/services/ensembl/types.js';

/** Where to read what `id` names, by the type Ensembl holds it as; none for a type nothing here reads. */
function readInstead(id: string, { objectType, parentId }: OtherObject): string | undefined {
  switch (objectType) {
    case 'Gene':
      return `Read the gene with ensembl://gene/${id}; its transcripts list names the transcript IDs this resource reads.`;
    case 'Translation':
      return `Read ${parentId ? `its transcript with ensembl://transcript/${parentId}, or ` : ''}the protein with ensembl_get_sequence (id ${id}, type "protein").`;
    case 'Exon':
      return `Read the exon's sequence with ensembl_get_sequence (id ${id}).`;
    default:
      return undefined;
  }
}

export const ensemblTranscriptResource = resource('ensembl://transcript/{id}', {
  name: 'Ensembl Transcript',
  description:
    'Transcript record by Ensembl stable transcript ID (ENST00000380152, or the form the species uses, such as AT1G01010.1, FBtr0070823, or LRG_1t1). Returns parent gene, location, biotype, canonical flag, and length. An ID Ensembl holds as a gene, translation, or exon is refused, naming the type found and where to read it. Use canonicalTranscript from ensembl_lookup_gene, or expand_transcripts=true for all transcript IDs and MANE Select accessions, then fetch this resource for stable, injectable context.',
  mimeType: 'application/json',
  params: z.object({
    id: z
      .string()
      .describe(
        'Ensembl stable transcript ID: ENST00000380152, or the form the species uses (AT1G01010.1, FBtr0070823, YFL039C_mRNA, LRG_1t1). A version suffix on an ENS… or LRG ID (ENST00000380152.8, LRG_1t1.1) is optional and dropped before the lookup, so either form returns the current version.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The transcript stable ID was not found in Ensembl.',
      recovery:
        'Check the ID for typos: a version suffix is already dropped from an ENS… or LRG ID, so one still not found is mistyped or retired. Use canonicalTranscript from ensembl_lookup_gene or expand_transcripts=true for all transcript IDs.',
    },
    {
      reason: 'wrong_object_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Ensembl holds the stable ID as a gene, translation, or exon rather than a transcript.',
      recovery:
        'Read a gene ID with ensembl://gene/{id}, a translation through its parent transcript here or as a protein with ensembl_get_sequence, and an exon with ensembl_get_sequence.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Fetching transcript resource', { id: params.id });
    const service = getEnsemblService();

    const found = await service.lookupTranscript(params.id, ctx).catch((err: unknown) => {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'not_found',
          `Transcript ${params.id} not found in Ensembl.`,
          { ...ctx.recoveryFor('not_found') },
          { cause: err },
        );
      }
      throw err;
    });
    if (found.kind === 'transcript') return found.transcript;

    const { objectType, parentId } = found;
    const hint = readInstead(params.id, found);
    throw ctx.fail(
      'wrong_object_type',
      `${params.id} is not a transcript: its Ensembl object_type is ${objectType}.${parentId ? ` Its parent is ${parentId}.` : ''}`,
      { objectType, ...(parentId && { parentId }), ...(hint && { recovery: { hint } }) },
    );
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
