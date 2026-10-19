/**
 * @fileoverview Tool to fetch DNA, cDNA, CDS, or protein sequences for Ensembl IDs or genomic regions.
 * @module mcp-server/tools/definitions/get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  isMitochondrionAlias,
  isReversed,
  mentionsInOrder,
  mitochondrionMessage,
  parseRegion,
  reversedMessage,
} from '@/mcp-server/tools/region-grammar.js';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { SequenceRecord } from '@/services/ensembl/types.js';

const SEQUENCE_TYPES = ['genomic', 'cdna', 'cds', 'protein'] as const;

/** Ensembl's rejection of an unknown species; it quotes the name it could not find. */
const UNKNOWN_SPECIES = /can not find internal name for species/i;

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
    'a :-1 suffix (13:32315086-32315100:-1) returns the reverse-strand sequence. ' +
    'Regions return genomic DNA only. Protein sequences require a transcript or protein stable ID ' +
    '(ENST…/ENSP…), not a gene ID — use ' +
    'ensembl_lookup_gene and its canonicalTranscript field first; expand_transcripts=true also supplies transcript biotypes and MANE Select accessions.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Ensembl stable ID (ENSG…, ENST…, ENSP…) or a genomic region for region mode — an id ' +
          'containing a colon is a region. A version suffix on a stable ID (ENST00000380152.8) is ' +
          'dropped before the request. Region accepts species:chr:start-end ' +
          '(e.g. homo_sapiens:13:32315086-32400268) or a bare chr:start-end ' +
          '(e.g. 13:32315086-32400268) when the species field is set. Coordinates are whole ' +
          'numbers; start..end works as well as start-end, and a :1 or :-1 suffix picks the ' +
          'strand (13:32315086-32315100:-1 returns the reverse complement). A region needs start ' +
          'at or below end, within the sequence region, and spans at most 10,000,000 bases. ' +
          'Name chromosomes as Ensembl does (13, X, MT; chr13 also works); the mitochondrion is MT ' +
          'in vertebrates, mitochondrion_genome in Drosophila, and MtDNA in C. elegans. M and chrM ' +
          'are accepted only where Ensembl resolves them to the mitochondrion (Drosophila, for ' +
          'one); elsewhere they fail as invalid_region naming the mitochondrion of the species.',
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
          'Region ids are genomic-only — request cdna, cds, or protein from a transcript or protein stable ID. ' +
          'A protein ID (ENSP…) serves only its protein; a non-coding transcript has no protein or cds.',
      ),
    species: z
      .string()
      .optional()
      .describe(
        'Species in Ensembl internal format (e.g. homo_sapiens). ' +
          'Required for a bare chr:start-end region. For the species:chr:start-end form the ' +
          'species in id takes precedence and this field is ignored. ' +
          'Unused for stable ID lookups — Ensembl infers species from the ID prefix.',
      ),
    expand_5prime: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Number of base pairs to extend upstream (5' direction) of the requested feature. " +
          'Default 0. Only applies to genomic sequences and region queries; on a :-1 region ' +
          'it extends the higher coordinate.',
      ),
    expand_3prime: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Number of base pairs to extend downstream (3' direction) of the requested feature. " +
          'Default 0. Only applies to genomic sequences and region queries; on a :-1 region ' +
          'it extends the lower coordinate.',
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
        'Verify the ID format (ENSG…, ENST…, ENSP…) or region coordinates. A version suffix is ' +
        'already dropped from an ENS… ID, so one still not found is mistyped or retired. ' +
        'Use ensembl_lookup_gene to get valid stable IDs first.',
    },
    {
      reason: 'type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when:
        'The requested type does not exist for the id: cdna, cds, or protein for a region id or a ' +
        'gene ID; genomic, cdna, or cds for a protein ID; or protein or cds for a non-coding transcript.',
      recovery:
        'Region ids are genomic-only, a gene ID serves only its genomic sequence, and a protein ID ' +
        'serves only its protein. Request cdna or cds from a transcript ID (ENST…) and protein from ' +
        'a transcript or protein ID (ENST…/ENSP…); a non-coding transcript has no protein or CDS, so ' +
        'request cdna or genomic from it. Use canonicalTranscript from ensembl_lookup_gene; ' +
        'expand_transcripts=true adds transcript biotypes, then request the sequence from that ' +
        'transcript ID.',
    },
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The species of a region (the species field or the species prefix in id) was not recognized by Ensembl.',
      recovery:
        'Find the internal name with ensembl_list_species, setting nameContains to a genus or ' +
        'common name (e.g. mouse) and division for non-vertebrates. Names are lowercase_underscore ' +
        '(mus_musculus, not Mouse).',
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
        'A region id is not in the [species:]chr:start-end form, has its start after its end, ' +
        'starts past the end of its sequence region, spans more than the 10,000,000-base maximum, ' +
        'names the mitochondrion M or chrM where Ensembl resolves that to another region or none, ' +
        'or names a sequence region the species lacks.',
      recovery:
        'Write the region as [species:]chr:start-end with whole-number coordinates (start..end ' +
        'and a :1 or :-1 strand suffix also work, e.g. 13:32315086-32315100:-1). Give start at or ' +
        'below end, within the sequence region length for the target assembly, spanning at most ' +
        '10,000,000 bases; split a longer region into windows of at most 10,000,000 bases. Name ' +
        'the chromosome as Ensembl does (13, X, MT; chr13 is also accepted) — the mitochondrion ' +
        'is MT in vertebrates, mitochondrion_genome in Drosophila, and MtDNA in C. elegans; use ' +
        'that name where M or chrM is rejected. ensembl_lookup_gene reports valid coordinates ' +
        'for any gene.',
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

    let resolved: SequenceRecord;
    // Stable IDs never contain a colon, so an id with one is region input, and the
    // grammar decides whether it carries a species prefix.
    if (input.id.includes(':')) {
      const parsed = parseRegion(input.id);
      if (!parsed) {
        throw ctx.fail(
          'invalid_region',
          `Region ${input.id} is not a valid region. Write it as [species:]chr:start-end with ` +
            'whole-number coordinates; chr:start..end and a :1 or :-1 strand suffix are also accepted.',
        );
      }
      // Ensembl's region endpoint serves genomic DNA only and ignores a type parameter,
      // so a cdna/cds/protein request would come back as genomic — reject it up front.
      if (input.type !== 'genomic') {
        throw ctx.fail(
          'type_mismatch',
          `Region ids are genomic-only — type "${input.type}" is not available for region ${input.id}.`,
        );
      }
      // A species prefix names the organism the coordinates belong to, so it wins over
      // the species field.
      const species = parsed.species ?? input.species?.trim();
      if (!species) {
        throw ctx.fail(
          'missing_species',
          `Region ${input.id} needs a species — set species (e.g. homo_sapiens) or use the species:chr:start-end id form.`,
        );
      }
      if (isReversed(parsed)) {
        throw ctx.fail('invalid_region', reversedMessage(input.id, parsed));
      }
      const failOnUnknownSpecies = (err: unknown) => {
        if (UNKNOWN_SPECIES.test(err instanceof Error ? err.message : String(err))) {
          throw ctx.fail('invalid_species', `Species "${species}" not recognized by Ensembl.`);
        }
      };
      if (isMitochondrionAlias(parsed.chromosome)) {
        const check = await service
          .checkMitochondrionAlias(species, parsed.chromosome, ctx)
          .catch((err: unknown) => {
            failOnUnknownSpecies(err);
            throw err;
          });
        if (!check.resolves) {
          throw ctx.fail(
            'invalid_region',
            mitochondrionMessage(parsed.region, parsed.chromosome, species, check.mitochondrion),
          );
        }
      }
      resolved = await service
        .getSequenceByRegion(species, parsed.region, input.expand_5prime, input.expand_3prime, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          failOnUnknownSpecies(err);
          if (/cannot request a slice|maximum allowed length|no slice found/i.test(msg)) {
            throw ctx.fail('invalid_region', `Invalid region ${input.id}: ${msg}`);
          }
          if (/not found|invalid|no stable id/i.test(msg)) {
            throw ctx.fail('not_found', `Region ${input.id} not found: ${msg}`);
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
          // An object with no sequence of the requested type, such as a non-coding
          // transcript asked for protein or cds.
          if (!notFound && /no sequences returned/i.test(msg)) {
            throw ctx.fail(
              'type_mismatch',
              `Ensembl has no ${input.type} sequence for ${input.id}. A non-coding transcript has no ` +
                'protein or CDS sequence — request cdna or genomic from it instead.',
            );
          }
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
                `Use canonicalTranscript from ensembl_lookup_gene, or expand_transcripts=true for all transcript IDs.`,
            );
          }
          if (notFound) {
            throw ctx.fail('not_found', `ID ${input.id} not found in Ensembl.`);
          }
          throw err;
        });
      // A protein ID answers every type with its protein, so the molecule Ensembl
      // returned — not the ID prefix, which varies by species — decides the mismatch.
      if (resolved.molecule === 'protein' && input.type !== 'protein') {
        throw ctx.fail(
          'type_mismatch',
          `${input.id} is a protein ID: Ensembl serves only its protein sequence, not ${input.type}. ` +
            `Request type "protein", or request ${input.type} from the transcript (ENST…) that encodes it.`,
        );
      }
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

    // molecule served the type check above; the output reports the type, never both.
    const { molecule: _molecule, ...record } = resolved;
    return {
      ...record,
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
