/**
 * @fileoverview Tool to fetch DNA, cDNA, CDS, or protein sequences for Ensembl IDs or genomic regions.
 * @module mcp-server/tools/definitions/get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { SequenceRecord } from '@/services/ensembl/types.js';

const SEQUENCE_TYPES = ['genomic', 'cdna', 'cds', 'protein'] as const;

/**
 * Linear-time `/first.*second/i`: `first`, then `second` later on the same line.
 * Ensembl echoes the caller's ID into its error text, and the backtracking regex
 * is quadratic in that echo.
 */
function mentionsInOrder(msg: string, first: string, second: string): boolean {
  return msg
    .toLowerCase()
    .split(/[\n\r\u2028\u2029]/)
    .some((line) => {
      const at = line.indexOf(first);
      return at !== -1 && line.includes(second, at + first.length);
    });
}

export const ensemblGetSequence = tool('ensembl_get_sequence', {
  title: 'Get Sequence',
  description:
    'Fetch the DNA, cDNA, CDS, or protein sequence for a gene, transcript, protein, or genomic region. ' +
    'Returns a window of the sequence — the first 10,000 characters by default — with its stable ID, ' +
    'molecule type, and full length. When more follows the window, truncated is true and nextOffset is the ' +
    'offset to request next; walking nextOffset reconstructs the whole sequence, and max_length 0 returns ' +
    'everything from offset to the end. The type parameter selects which sequence is fetched: genomic ' +
    '(default, includes introns), cdna (spliced transcript), cds (coding sequence only), protein. ' +
    'For region mode, set id to a region — either species:chr:start-end ' +
    '(e.g. homo_sapiens:13:32315086-32400268) or a bare chr:start-end with species set ' +
    '(e.g. id 13:32315086-32400268, species homo_sapiens), spanning at most 10,000,000 bases; ' +
    'regions return genomic DNA only. Protein sequences require a transcript or protein stable ID ' +
    '(ENST…/ENSP…), not a gene ID — use ' +
    'ensembl_lookup_gene with expand_transcripts=true to get the canonical transcript ID first.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Ensembl stable ID (ENSG…, ENST…, ENSP…) or a genomic region for region mode. ' +
          'Region accepts species:chr:start-end (e.g. homo_sapiens:13:32315086-32400268) or a bare ' +
          'chr:start-end (e.g. 13:32315086-32400268) when the species field is set. A region needs ' +
          'start at or below end, within the sequence region, and spans at most 10,000,000 bases.',
      ),
    type: z
      .enum(SEQUENCE_TYPES)
      .default('genomic')
      .describe(
        'Sequence type to retrieve. ' +
          'genomic: full genomic DNA including introns (default). ' +
          'cdna: spliced transcript sequence (requires ENST… ID). ' +
          'cds: coding sequence only, no UTRs (requires ENST… ID with coding transcript). ' +
          'protein: amino acid sequence (requires ENST… or ENSP… ID). ' +
          'Region ids are genomic-only — request cdna, cds, or protein from a transcript or protein stable ID.',
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        '0-based character offset where the returned window starts, counted in the resolved sequence ' +
          '(including any expand_5prime/expand_3prime flank). Default 0. Pass nextOffset from a truncated ' +
          'response to fetch the following window; an offset at or past the end returns an empty window.',
      ),
    max_length: z
      .number()
      .int()
      .min(0)
      .default(10_000)
      .describe(
        'Maximum number of characters in the returned window. Default 10000. ' +
          'Set to 0 to return everything from offset to the end, uncapped.',
      ),
  }),
  output: z.object({
    id: z.string().describe('The stable ID or region used for the lookup.'),
    type: z.string().describe('Sequence type returned (genomic, cdna, cds, or protein).'),
    seq: z
      .string()
      .describe(
        'The requested window of the sequence: at most max_length characters starting at offset. ' +
          'DNA sequences use IUPAC nucleotide codes (ACGT + ambiguity codes); protein sequences use ' +
          'single-letter amino acid codes. Empty when offset is at or past the end.',
      ),
    length: z
      .number()
      .describe(
        'Full sequence length in characters, not the window size — nucleotides for genomic/cdna/cds, ' +
          'amino-acid residues for protein. Includes any expand_5prime/expand_3prime flank.',
      ),
    offset: z.number().describe('0-based character offset where this window starts.'),
    truncated: z
      .boolean()
      .describe('True when more sequence follows this window; request nextOffset to continue.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the first character after this window — pass it as offset to fetch the next ' +
          'window. Present only when truncated.',
      ),
    description: z.string().optional().describe('Sequence description from Ensembl, if provided.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance about the window: how to continue when truncated, or why it is empty when the ' +
          'offset is past the end.',
      ),
  },

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
      when: 'A non-genomic type (cdna, cds, or protein) was requested for a region id or a gene ID.',
      recovery:
        'Region ids are genomic-only, and a gene ID serves only its genomic sequence. Request cdna or ' +
        'cds from a transcript ID (ENST…) and protein from a transcript or protein ID (ENST…/ENSP…). ' +
        'Use ensembl_lookup_gene with expand_transcripts=true to find the canonical transcript ID, ' +
        'then request the sequence from that transcript ID.',
    },
    {
      reason: 'missing_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A bare chr:start-end region was given without a species.',
      recovery:
        'Set species (e.g. homo_sapiens) alongside the chr:start-end region, ' +
        'or use the combined species:chr:start-end id form.',
    },
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when:
        'A region id has its start after its end, starts past the end of its sequence region, ' +
        'spans more than the 10,000,000-base maximum, or names a sequence region the species lacks.',
      recovery:
        'Give start at or below end, within the sequence region length for the target assembly, ' +
        'spanning at most 10,000,000 bases; split a longer region into windows of at most ' +
        '10,000,000 bases. Name the chromosome as Ensembl does (13, X, MT; chr13 is also ' +
        'accepted) — ensembl_lookup_gene reports valid coordinates for any gene.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching sequence', {
      id: input.id,
      type: input.type,
      offset: input.offset,
      maxLength: input.max_length,
    });
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

    let resolved: SequenceRecord;
    if (isPrefixedRegion || isBareRegion) {
      // Ensembl's region endpoint serves genomic DNA only and ignores a type parameter,
      // so a cdna/cds/protein request would come back as genomic — reject it up front.
      if (input.type !== 'genomic') {
        throw ctx.fail(
          'type_mismatch',
          `Region ids are genomic-only — type "${input.type}" is not available for region ${input.id}.`,
          { ...ctx.recoveryFor('type_mismatch') },
        );
      }
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
          { ...ctx.recoveryFor('missing_species') },
        );
      }
      // Both region shapes end in start-end after the last colon. Comparing the digit
      // strings (length, then lexically) stays exact past double precision and linear
      // in the caller's input, where BigInt parsing is not.
      const [start = '', end = ''] = region
        .slice(region.lastIndexOf(':') + 1)
        .split('-')
        .map((digits) => digits.replace(/^0+(?=\d)/, ''));
      if (start.length > end.length || (start.length === end.length && start > end)) {
        throw ctx.fail(
          'invalid_region',
          `Region ${input.id} is reversed: start ${start} is greater than its end ${end}.`,
          { ...ctx.recoveryFor('invalid_region') },
        );
      }
      resolved = await service
        .getSequenceByRegion(species, region, input.expand_5prime, input.expand_3prime, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/cannot request a slice|maximum allowed length|no slice found/i.test(msg)) {
            throw ctx.fail('invalid_region', `Invalid region ${input.id}: ${msg}`, {
              ...ctx.recoveryFor('invalid_region'),
            });
          }
          if (/not found|invalid|no stable id/i.test(msg)) {
            throw ctx.fail('not_found', `Region ${input.id} not found: ${msg}`, {
              ...ctx.recoveryFor('not_found'),
            });
          }
          throw err;
        });
    } else {
      resolved = await service
        .getSequenceById(input.id, input.type, input.expand_5prime, input.expand_3prime, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Ensembl echoes the requested ID into "ID '<id>' not found", and the echo can
          // contain any word — so the looser type heuristics never override a not-found.
          const notFound = /not found|no stable id/i.test(msg);
          if (
            /requesting a gene and type not equal|multiple sequences detected/i.test(msg) ||
            (!notFound &&
              (mentionsInOrder(msg, 'protein', 'gene') ||
                mentionsInOrder(msg, 'cds', 'gene') ||
                mentionsInOrder(msg, 'type', 'mismatch') ||
                /incompatible/i.test(msg)))
          ) {
            throw ctx.fail(
              'type_mismatch',
              `Cannot request type "${input.type}" from a gene ID — use a transcript or protein stable ID instead. ` +
                `Call ensembl_lookup_gene with expand_transcripts=true to get transcript IDs.`,
              { ...ctx.recoveryFor('type_mismatch') },
            );
          }
          if (notFound) {
            throw ctx.fail('not_found', `ID ${input.id} not found in Ensembl.`, {
              ...ctx.recoveryFor('not_found'),
            });
          }
          throw err;
        });
    }

    // The window is a post-fetch slice of the resolved sequence, so it indexes past any
    // expansion flank and `length` stays the full length. Ensembl's own start/end trim
    // would hide the full length and cannot be combined with expansion.
    const { length } = resolved;
    const end = input.max_length > 0 ? Math.min(input.offset + input.max_length, length) : length;
    const truncated = end < length;
    if (input.offset >= length) {
      ctx.enrich.notice(
        `No characters returned: offset ${input.offset} is at or past the end of the sequence, ` +
          `which is ${length.toLocaleString()} characters long. Request an offset below the length.`,
      );
    } else if (truncated) {
      ctx.enrich.notice(
        `Showing ${(end - input.offset).toLocaleString()} of ${length.toLocaleString()} characters ` +
          `from offset ${input.offset}. Call again with offset ${end} for the next window, or set ` +
          'max_length to 0 for everything from offset to the end.',
      );
    }

    return {
      ...resolved,
      seq: resolved.seq.slice(input.offset, end),
      offset: input.offset,
      truncated,
      ...(truncated && { nextOffset: end }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Sequence: ${result.id}`);
    const unit = result.type === 'protein' ? 'residues' : 'bp';
    lines.push(`**Type:** ${result.type} | **Length:** ${result.length.toLocaleString()} ${unit}`);
    if (result.description) lines.push(`**Description:** ${result.description}`);
    const extent = result.truncated
      ? `truncated; next offset ${result.nextOffset}`
      : 'not truncated (nothing follows this window)';
    lines.push(
      `**Window:** ${result.seq.length.toLocaleString()} characters from offset ${result.offset} ` +
        `of ${result.length.toLocaleString()} — ${extent}`,
    );
    lines.push('');
    if (result.seq) {
      lines.push('```', result.seq, '```');
    } else {
      lines.push('_No sequence characters at this offset._');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
