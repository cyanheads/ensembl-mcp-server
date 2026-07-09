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
    'cds (coding sequence only), protein. For region mode, set id to a region — either ' +
    'species:chr:start-end (e.g. homo_sapiens:13:32315086-32400268) or a bare chr:start-end with ' +
    'species set (e.g. id 13:32315086-32400268, species homo_sapiens). Protein sequences require a transcript or ' +
    'protein stable ID (ENST…/ENSP…), not a gene ID — use ensembl_lookup_gene with expand_transcripts=true ' +
    'to get the canonical transcript ID first.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    id: z
      .string()
      .describe(
        'Ensembl stable ID (ENSG…, ENST…, ENSP…) or a genomic region for region mode. ' +
          'Region accepts species:chr:start-end (e.g. homo_sapiens:13:32315086-32400268) or a bare ' +
          'chr:start-end (e.g. 13:32315086-32400268) when the species field is set.',
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
          'Required for a bare chr:start-end region; optional for the species:chr:start-end form ' +
          '(the embedded species is used when the field is omitted). ' +
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
    {
      reason: 'missing_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A bare chr:start-end region was given without a species.',
      recovery:
        'Set species (e.g. homo_sapiens) alongside the chr:start-end region, ' +
        'or use the combined species:chr:start-end id form.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching sequence', { id: input.id, type: input.type });
    const service = getEnsemblService();

    // Region mode accepts two id shapes:
    //   species:chr:start-end   embedded species (e.g. homo_sapiens:13:32315086-32400268)
    //   chr:start-end           bare region — the species field supplies the species
    // Scaffold/patch names carry dots (e.g. GL000220.1), so the chromosome segment
    // allows "." alongside word characters. Colon count is the discriminant: the two
    // patterns are mutually exclusive (2 colons vs. 1), and a stable ID (ENSG…, no
    // colon) matches neither, routing to stable-ID mode below.
    const isPrefixedRegion = /^[a-z_]+:[\w.]+:\d+-\d+$/i.test(input.id);
    const isBareRegion = /^[\w.]+:\d+-\d+$/.test(input.id);

    if (isPrefixedRegion || isBareRegion) {
      // For the prefixed form the species is the segment before the first colon and
      // the region is everything after it; the bare form takes its species from the
      // species field and uses the whole id as the region.
      const firstColon = input.id.indexOf(':');
      const species =
        input.species?.trim() || (isPrefixedRegion ? input.id.slice(0, firstColon) : undefined);
      const region = isPrefixedRegion ? input.id.slice(firstColon + 1) : input.id;
      if (!species) {
        throw ctx.fail(
          'missing_species',
          `Region ${input.id} needs a species — set species (e.g. homo_sapiens) or use the species:chr:start-end id form.`,
        );
      }
      const seq = await service
        .getSequenceByRegion(species, region, input.expand_5prime, input.expand_3prime, ctx)
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
      .getSequenceById(input.id.trim(), input.type, input.expand_5prime, input.expand_3prime, ctx)
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
