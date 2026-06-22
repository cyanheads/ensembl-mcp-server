/**
 * @fileoverview Tool to fetch DNA, cDNA, CDS, or protein sequences for Ensembl IDs or genomic regions.
 * @module mcp-server/tools/definitions/get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const SEQUENCE_TYPES = ['genomic', 'cdna', 'cds', 'protein'] as const;

export const ensemblGetSequence = tool('ensembl_get_sequence', {
  title: 'Get Sequence',
  description:
    'Fetch the DNA, cDNA, CDS, or protein sequence for a gene, transcript, protein, or genomic region. ' +
    'Returns the sequence with its stable ID, molecule type, and character count — large sequences are ' +
    'returned in full but the length is stated so callers can budget context. The type parameter selects ' +
    'which sequence is fetched: genomic (default, includes introns), cdna (spliced transcript), ' +
    'cds (coding sequence only), protein. For region mode, set id to the format species:chr:start-end ' +
    '(e.g. homo_sapiens:13:32315086-32400268) and set species. Protein sequences require a transcript or ' +
    'protein stable ID (ENST…/ENSP…), not a gene ID — use ensembl_lookup_gene with expand_transcripts=true ' +
    'to get the canonical transcript ID first.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    id: z
      .string()
      .describe(
        'Ensembl stable ID (ENSG…, ENST…, ENSP…) or region in the format ' +
          'species:chr:start-end (e.g. homo_sapiens:13:32315086-32400268) for region mode. ' +
          'For genomic region queries, species is also required.',
      ),
    type: z
      .enum(SEQUENCE_TYPES)
      .default('genomic')
      .describe(
        'Sequence type to retrieve. ' +
          'genomic: full genomic DNA including introns (default). ' +
          'cdna: spliced transcript sequence (requires ENST… ID). ' +
          'cds: coding sequence only, no UTRs (requires ENST… ID with coding transcript). ' +
          'protein: amino acid sequence (requires ENST… or ENSP… ID).',
      ),
    species: z
      .string()
      .optional()
      .describe(
        'Species in Ensembl internal format (e.g. homo_sapiens). ' +
          'Required for region mode (when id is a species:chr:start-end string). ' +
          'Optional for stable ID lookups — Ensembl infers species from the ID prefix.',
      ),
    expand_5prime: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Number of base pairs to extend upstream (5' direction) of the requested feature. " +
          'Default 0. Only applies to genomic sequences and region queries.',
      ),
    expand_3prime: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Number of base pairs to extend downstream (3' direction) of the requested feature. " +
          'Default 0. Only applies to genomic sequences and region queries.',
      ),
  }),
  output: z.object({
    id: z.string().describe('The stable ID or region used for the lookup.'),
    type: z.string().describe('Sequence type returned (genomic, cdna, cds, or protein).'),
    seq: z
      .string()
      .describe(
        'The full sequence. DNA sequences use IUPAC nucleotide codes (ACGT + ambiguity codes). ' +
          'Protein sequences use single-letter amino acid codes. ' +
          'Large genomic sequences (e.g. 85 kb for BRCA2) are returned in full.',
      ),
    length: z
      .number()
      .describe(
        'Sequence length in characters — nucleotides for genomic/cdna/cds, amino-acid residues for protein. ' +
          'Use this to budget context window usage before processing the sequence.',
      ),
    description: z.string().optional().describe('Sequence description from Ensembl, if provided.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The stable ID or region was not found in Ensembl.',
      recovery:
        'Verify the ID format (ENSG…, ENST…, ENSP…) or region coordinates. ' +
        'Use ensembl_lookup_gene to get valid stable IDs first.',
    },
    {
      reason: 'type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested sequence type is incompatible with the provided ID type.',
      recovery:
        'protein and cds sequences require a transcript ID (ENST…) or protein ID (ENSP…), not a gene ID. ' +
        'Use ensembl_lookup_gene with expand_transcripts=true to find the canonical transcript ID, ' +
        'then request the protein or cds sequence from that transcript ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching sequence', { id: input.id, type: input.type });
    const service = getEnsemblService();

    // Detect region mode: contains ":" after optional species prefix.
    // Scaffold/patch names carry dots (e.g. GL000220.1), so the chromosome
    // segment allows "." in addition to word characters.
    const regionPattern = /^[a-z_]+:[\w.]+:\d+-\d+$/i;
    const isRegion = regionPattern.test(input.id);

    if (isRegion) {
      // Parse "species:chr:start-end"
      const parts = input.id.split(':');
      if (parts.length !== 3) {
        throw ctx.fail(
          'not_found',
          `Region format should be species:chr:start-end, got: ${input.id}`,
        );
      }
      const [speciesFromId, chr, range] = parts as [string, string, string];
      const speciesStr = input.species?.trim() || speciesFromId;
      const region = `${chr}:${range}`;
      const seq = await service
        .getSequenceByRegion(speciesStr, region, input.expand_5prime, input.expand_3prime, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found|invalid|no stable id/i.test(msg)) {
            throw ctx.fail('not_found', `Region ${input.id} not found: ${msg}`);
          }
          throw err;
        });
      return seq;
    }

    // Stable ID mode
    const seq = await service
      .getSequenceById(input.id.trim(), input.type, ctx)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /protein.*gene|cds.*gene|type.*mismatch|incompatible/i.test(msg) ||
          /requesting a gene and type not equal/i.test(msg) ||
          /multiple sequences detected/i.test(msg)
        ) {
          throw ctx.fail(
            'type_mismatch',
            `Cannot request type "${input.type}" from a gene ID — use a transcript or protein stable ID instead. ` +
              `Call ensembl_lookup_gene with expand_transcripts=true to get transcript IDs.`,
          );
        }
        if (/not found|no stable id/i.test(msg)) {
          throw ctx.fail('not_found', `ID ${input.id} not found in Ensembl.`);
        }
        throw err;
      });
    return seq;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Sequence: ${result.id}`);
    const unit = result.type === 'protein' ? 'residues' : 'bp';
    lines.push(`**Type:** ${result.type} | **Length:** ${result.length.toLocaleString()} ${unit}`);
    if (result.description) lines.push(`**Description:** ${result.description}`);
    lines.push('');
    // Show first 200 chars + truncation note for large sequences
    if (result.seq.length > 200) {
      lines.push('```');
      lines.push(result.seq.slice(0, 200));
      lines.push(`… (${result.length.toLocaleString()} total characters)`);
      lines.push('```');
    } else {
      lines.push('```');
      lines.push(result.seq);
      lines.push('```');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
