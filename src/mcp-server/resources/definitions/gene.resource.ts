/**
 * @fileoverview Resource exposing Ensembl gene records by stable ID.
 * @module mcp-server/resources/definitions/gene
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { OtherObject } from '@/services/ensembl/types.js';

/** Where to read what `id` names, by the type Ensembl holds it as; none for a type nothing here reads. */
function readInstead(id: string, { objectType, parentId }: OtherObject): string | undefined {
  switch (objectType) {
    case 'Transcript':
      return `Read ${parentId ? `its gene with ensembl://gene/${parentId}, or ` : ''}the transcript with ensembl://transcript/${id}.`;
    case 'Translation':
      return `Read ${parentId ? `its transcript with ensembl://transcript/${parentId}, whose parentGeneId names the gene, or ` : ''}the protein with ensembl_get_sequence (id ${id}, type "protein").`;
    case 'Exon':
      return `Read the exon's sequence with ensembl_get_sequence (id ${id}).`;
    default:
      return undefined;
  }
}

export const ensemblGeneResource = resource('ensembl://gene/{id}', {
  name: 'Ensembl Gene',
  description:
    'Gene record by Ensembl stable gene ID (ENSG00000139618, or the form the species uses, such as AT1G01010, FBgn0000042, or LRG_1). Returns location, biotype, description, canonicalTranscript, and a transcript list with MANE Select accessions when available. An ID Ensembl holds as a transcript, translation, or exon is refused, naming the type found and where to read it. Stable, injectable context for multi-step workflows. Use ensembl_lookup_gene to resolve a gene symbol to the stable ID first.',
  mimeType: 'application/json',
  params: z.object({
    id: z
      .string()
      .describe(
        'Ensembl stable gene ID: ENSG00000139618, or the form the species uses (AT1G01010, FBgn0000042, YFL039C, LRG_1). A version suffix on an ENS… ID (ENSG00000139618.19) is optional and dropped before the lookup, so either form returns the current version.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The gene stable ID was not found in Ensembl.',
      recovery:
        'Check the ID for typos: a version suffix is already dropped from an ENS… ID, so one still not found is mistyped or retired. Use ensembl_lookup_gene to resolve a symbol to a current stable ID.',
    },
    {
      reason: 'wrong_object_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Ensembl holds the stable ID as a transcript, translation, or exon rather than a gene.',
      recovery:
        'Read a transcript ID with ensembl://transcript/{id} or its parent gene here, a translation through its parent transcript, and a translation or exon sequence with ensembl_get_sequence.',
    },
  ],

  async handler(params, ctx) {
    ctx.log.debug('Fetching gene resource', { id: params.id });
    const service = getEnsemblService();

    const found = await service.lookupGeneOnly(params.id, ctx).catch((err: unknown) => {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'not_found',
          `Gene ${params.id} not found in Ensembl.`,
          { ...ctx.recoveryFor('not_found') },
          { cause: err },
        );
      }
      throw err;
    });
    if (found.kind === 'gene') return found.gene;

    const { objectType, parentId } = found;
    const hint = readInstead(params.id, found);
    throw ctx.fail(
      'wrong_object_type',
      `${params.id} is not a gene: its Ensembl object_type is ${objectType}.${parentId ? ` Its parent is ${parentId}.` : ''}`,
      { objectType, ...(parentId && { parentId }), ...(hint && { recovery: { hint } }) },
    );
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
