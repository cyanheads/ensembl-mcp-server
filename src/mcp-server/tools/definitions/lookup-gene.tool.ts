/**
 * @fileoverview Tool to resolve genes by symbol + species or by Ensembl stable ID.
 * A symbol that matches no current gene name falls back to Ensembl's external
 * names (synonyms, former symbols), which can resolve to one gene or several.
 * @module mcp-server/tools/definitions/lookup-gene
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { renderHeading } from '@/mcp-server/tools/render-heading.js';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';
import type { GeneRecord } from '@/services/ensembl/types.js';

/** Ensembl's answer when `/lookup/symbol` has no gene with that current name. */
const DIRECT_MISS = /No valid lookup found for symbol/i;

/** Ensembl's answer for a species string it does not recognize. */
const UNKNOWN_SPECIES = /Can not find internal name for species/i;

const TranscriptSummarySchema = z.object({
  maneSelect: z
    .string()
    .optional()
    .describe('MANE Select RefSeq transcript accession, when supplied by Ensembl.'),
  id: z.string().describe('Ensembl transcript stable ID (ENST…).'),
  displayName: z.string().optional().describe('Transcript display name.'),
  biotype: z
    .string()
    .optional()
    .describe('Transcript biotype (e.g. protein_coding, lncRNA, retained_intron).'),
  isCanonical: z.boolean().describe('True when this is the canonical transcript for the gene.'),
  start: z.number().optional().describe('Transcript start position on the chromosome (1-based).'),
  end: z.number().optional().describe('Transcript end position on the chromosome (1-based).'),
  strand: z.number().optional().describe('Strand: 1 for forward, -1 for reverse.'),
  lengthInBp: z.number().optional().describe('Transcript length in base pairs.'),
});

const GeneRecordSchema = z.object({
  canonicalTranscript: z
    .string()
    .optional()
    .describe(
      'Canonical Ensembl transcript ID, including its version when supplied. Use for a primary protein sequence.',
    ),
  parentGeneId: z
    .string()
    .optional()
    .describe('Parent gene stable ID for a transcript-ID lookup. Absent for other object types.'),
  id: z
    .string()
    .describe('Ensembl gene stable ID (ENSG…). Use this as input to other Ensembl tools.'),
  species: z
    .string()
    .optional()
    .describe('Species in Ensembl internal format (e.g. homo_sapiens). Echoed from lookup.'),
  displayName: z.string().optional().describe('Gene symbol or display name (e.g. BRCA2, TP53).'),
  description: z.string().optional().describe('Brief gene description from Ensembl.'),
  biotype: z
    .string()
    .optional()
    .describe('Gene biotype (e.g. protein_coding, lncRNA, pseudogene).'),
  chromosome: z.string().optional().describe('Chromosome or sequence region name.'),
  start: z.number().optional().describe('Gene start position on the chromosome (1-based).'),
  end: z.number().optional().describe('Gene end position on the chromosome (1-based).'),
  strand: z.number().optional().describe('Strand: 1 for forward, -1 for reverse.'),
  assemblyName: z
    .string()
    .optional()
    .describe('Genome assembly name (e.g. GRCh38). All coordinates are relative to this assembly.'),
  transcripts: z
    .array(TranscriptSummarySchema.describe('A single transcript summary entry.'))
    .optional()
    .describe('Transcript list. Present only when expand_transcripts is true.'),
});

const GeneResultSchema = GeneRecordSchema.extend({
  matchedAlias: z
    .string()
    .optional()
    .describe(
      'The submitted symbol, present when it matched a synonym or former symbol rather than the ' +
        'current gene name; displayName holds the current name.',
    ),
});

const CandidatesSchema = z
  .array(GeneRecordSchema.describe('A gene the symbol is a synonym or former symbol of.'))
  .describe('Every gene the symbol maps to. Retry with id set to the intended one.');

const SucceededItemSchema = GeneResultSchema.extend({
  query: z.string().describe('The submitted ID or symbol this record resolved from.'),
});

const FailedItemSchema = z.object({
  query: z.string().describe('The submitted ID or symbol.'),
  reason: z
    .enum(['not_found', 'ambiguous', 'unavailable'])
    .describe(
      'not_found: nothing matched. ambiguous: the symbol is a synonym of several genes, ' +
        'listed in candidates. unavailable: Ensembl did not answer the synonym lookup for ' +
        'this symbol after retries, so whether it matches is unknown — retry it.',
    ),
  error: z.string().describe('What went wrong for this item.'),
  recovery: z.string().describe('The next step for this item.'),
  candidates: CandidatesSchema.optional().describe(
    'Every gene the symbol maps to. Present only when reason is ambiguous.',
  ),
});

const BatchResultSchema = z.object({
  omitted: z
    .array(z.string().describe('A distinct submitted query not attempted in this call.'))
    .describe(
      'Queries past the first 20 distinct items, in first-occurrence order. Resubmit these separately.',
    ),
  succeeded: z
    .array(SucceededItemSchema.describe('A resolved gene record carrying its submitted query.'))
    .describe('Records for IDs/symbols that resolved to one gene, in input order.'),
  failed: z
    .array(FailedItemSchema.describe('One unresolved ID or symbol.'))
    .describe('IDs/symbols that did not resolve to one gene, in input order.'),
});

type SucceededItem = z.infer<typeof SucceededItemSchema>;
type FailedItem = z.infer<typeof FailedItemSchema>;

/** Next step for a batch symbol whose synonym lookup Ensembl left unanswered. */
const UNAVAILABLE_RECOVERY =
  'Ensembl did not answer the synonym lookup for this symbol. Retry the call, or look the ' +
  'symbol up alone with the symbol field.';

/** Retry guidance for a symbol shared by several genes, naming each candidate's ID. */
function ambiguityGuidance(symbol: string, species: string, candidates: GeneRecord[]): string {
  const listed = candidates.map((g) => `${g.displayName ?? g.id} (${g.id})`).join(', ');
  return (
    `"${symbol}" is a synonym or former symbol of ${candidates.length} genes in ${species}: ` +
    `${listed}. Pick the intended gene and retry ensembl_lookup_gene with id set to its stable ID.`
  );
}

export const ensemblLookupGene = tool('ensembl_lookup_gene', {
  title: 'Lookup Gene',
  description:
    'Resolve a gene by symbol + species (or by stable ID) to its Ensembl ID, genomic location ' +
    '(chr:start-end:strand), biotype, description, and transcript list. Entry point for most workflows — ' +
    'the stable ID and coordinates returned here are inputs to other tools. Accepts both symbol lookup ' +
    '(BRCA2 + homo_sapiens) and direct ID lookup (ENSG00000139618). A symbol that is not a current gene ' +
    'name is matched against synonyms and former symbols (HER2 → ERBB2), reported as matchedAlias; when ' +
    'it maps to several genes the result is ambiguous, listing the candidates to retry by id. Supports ' +
    'batch submission of up to 1,000 IDs or symbols: the first 20 distinct queries are resolved, ' +
    'and batch.omitted names the unattempted remainder to resubmit. Provide exactly ' +
    'one of symbol, id, ids, or symbols. For symbol lookups species defaults to homo_sapiens (override ' +
    'for other organisms); for ID lookups species is not needed. Use ensembl_list_species with ' +
    'nameContains (a genus or common name) to find valid species names.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    symbol: z
      .string()
      .optional()
      .describe(
        'Gene symbol to look up (e.g. BRCA2, TP53, EGFR). ' +
          'Species defaults to homo_sapiens; set species for other organisms. ' +
          'Case-insensitive in most species. A synonym or former symbol (HER2, TB1) resolves too; ' +
          'one shared by several genes returns ambiguous with the candidates instead of gene.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Ensembl stable gene ID (e.g. ENSG00000139618). A version suffix on an ENS… ID ' +
          '(ENSG00000139618.19) is dropped before the lookup, which returns the current version. ' +
          'Species is not required for ID lookup.',
      ),
    species: z
      .string()
      .optional()
      .describe(
        'Species in Ensembl internal format: lowercase scientific name with underscores ' +
          '(e.g. homo_sapiens, mus_musculus, danio_rerio). ' +
          'Optional for symbol lookups — defaults to homo_sapiens; set it for other organisms. ' +
          'Use ensembl_list_species with nameContains (a genus or common name) to find valid values.',
      ),
    ids: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .describe('An Ensembl stable gene or transcript ID to resolve in this batch.'),
      )
      .max(1000)
      .optional()
      .describe(
        'Batch submission: up to 1,000 Ensembl stable IDs (ENSG…, ENST…); resolves the first 20 distinct trimmed queries. ' +
          'batch.omitted names the remainder to resubmit. A version suffix on an ENS… ' +
          'ID is dropped before the lookup. Returns a succeeded/failed/omitted partition; each attempted item carries ' +
          'its query — the ID as submitted, version included — and each failed item a reason and ' +
          'recovery. Provide exactly one of symbol, id, ids, or symbols.',
      ),
    symbols: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .describe('A gene symbol to resolve in this batch (e.g. BRCA2, TP53).'),
      )
      .max(1000)
      .optional()
      .describe(
        'Batch submission: up to 1,000 gene symbols; resolves the first 20 distinct trimmed queries. ' +
          'batch.omitted names the remainder to resubmit. ' +
          'Species defaults to homo_sapiens; set species for other organisms. ' +
          'Returns a succeeded/failed/omitted partition; each attempted item carries its submitted query. Synonyms and ' +
          'former symbols resolve with matchedAlias; one shared by several genes fails with ' +
          'reason ambiguous and its candidates. Provide exactly one of symbol, id, ids, or symbols.',
      ),
    expand_transcripts: z
      .boolean()
      .default(false)
      .describe(
        'When true, include the full transcript list in the response. ' +
          'Each transcript has its ID, biotype, canonical flag, and coordinates. ' +
          'Default is false to keep responses compact.',
      ),
  }),
  output: z.object({
    gene: GeneResultSchema.optional().describe(
      'Single gene record. Present for an id lookup, or a symbol lookup that resolved to one gene.',
    ),
    ambiguous: z
      .object({
        query: z.string().describe('The submitted symbol.'),
        candidates: CandidatesSchema,
        guidance: z.string().describe('How to pick a candidate and retry by id.'),
      })
      .optional()
      .describe(
        'Present instead of gene when a symbol is not a current gene name and is a synonym or ' +
          'former symbol of several genes.',
      ),
    batch: BatchResultSchema.optional().describe(
      'Batch results. Present for ids or symbols lookups.',
    ),
  }),

  enrichment: {
    notice: z.string().optional().describe('Guidance for resubmitting unattempted batch queries.'),
  },

  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The gene symbol or stable ID was not found in Ensembl.',
      recovery:
        'Verify the symbol spelling or ID format. Confirm the species name with ensembl_list_species ' +
        'and nameContains (a genus or common name), then retry. A version suffix is already dropped ' +
        'from an ENS… ID, so an ID still not found is mistyped or retired.',
    },
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The species string was not recognized by Ensembl.',
      recovery:
        'Find the internal name with ensembl_list_species, setting nameContains to a genus or ' +
        'common name (e.g. mouse) and division for non-vertebrates. Names are lowercase_underscore ' +
        '(homo_sapiens, not Human).',
    },
    {
      reason: 'no_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither symbol, id, ids, nor symbols was provided.',
      recovery:
        'Provide exactly one of: symbol (with species), id, ids array, or symbols array (with species).',
    },
    {
      reason: 'conflicting_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of symbol, id, ids, or symbols was provided.',
      recovery:
        'Provide exactly one input: a symbol, a stable id, an ids array, or a symbols array.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Looking up gene', {
      symbol: input.symbol,
      id: input.id,
      species: input.species,
      batchSize: input.ids?.length ?? input.symbols?.length,
    });
    const service = getEnsemblService();

    const inputCount = [
      input.symbol?.trim(),
      input.id?.trim(),
      input.ids?.length,
      input.symbols?.length,
    ].filter(Boolean).length;
    if (inputCount > 1) {
      throw ctx.fail('conflicting_input', 'Provide exactly one of: symbol, id, ids, or symbols.');
    }

    const notFoundRecovery = ctx.recoveryFor('not_found').recovery.hint;

    // --- Batch by IDs ---
    if (input.ids?.length) {
      const distinct = [...new Set(input.ids)];
      const ids = distinct.slice(0, 20);
      const omitted = distinct.slice(20);
      const map = await service.lookupGenesBatch(ids, input.expand_transcripts, ctx);
      const succeeded: SucceededItem[] = [];
      const failed: FailedItem[] = [];
      for (const id of ids) {
        const gene = map.get(id);
        if (gene) {
          succeeded.push({ query: id, ...gene });
        } else {
          failed.push({
            query: id,
            reason: 'not_found',
            error: `ID ${id} not found in Ensembl.`,
            recovery: notFoundRecovery,
          });
        }
      }
      if (omitted.length)
        ctx.enrich.notice(
          `${omitted.length} distinct queries were not attempted. Resubmit batch.omitted in another call; each call resolves at most 20 distinct queries.`,
        );
      return { batch: { succeeded, failed, omitted } };
    }

    // --- Batch by symbols ---
    if (input.symbols?.length) {
      const speciesStr = input.species?.trim() || 'homo_sapiens';
      const distinct = [...new Set(input.symbols)];
      const symbols = distinct.slice(0, 20);
      const omitted = distinct.slice(20);
      const direct = await service.lookupSymbolsBatch(
        symbols,
        speciesStr,
        input.expand_transcripts,
        ctx,
      );
      const misses = symbols.filter((s) => !direct.has(s));
      // Ensembl answers an unknown species with the same {} as an all-miss batch, so when
      // nothing resolved, the first miss's xref request runs alone as the species check.
      const aliases =
        misses.length > 0
          ? await service
              .resolveSymbolAliases(
                misses,
                speciesStr,
                input.expand_transcripts,
                ctx,
                direct.size === 0,
              )
              .catch((err: unknown) => {
                if (UNKNOWN_SPECIES.test(err instanceof Error ? err.message : String(err))) {
                  throw ctx.fail(
                    'invalid_species',
                    `Species "${speciesStr}" not recognized by Ensembl.`,
                  );
                }
                throw err;
              })
          : undefined;

      const succeeded: SucceededItem[] = [];
      const failed: FailedItem[] = [];
      for (const symbol of symbols) {
        const gene = direct.get(symbol);
        const alias = aliases?.get(symbol);
        if (gene) {
          succeeded.push({ query: symbol, ...gene });
        } else if (alias?.kind === 'gene') {
          succeeded.push({ query: symbol, ...alias.gene, matchedAlias: symbol });
        } else if (alias?.kind === 'ambiguous') {
          failed.push({
            query: symbol,
            reason: 'ambiguous',
            error: `Symbol ${symbol} maps to ${alias.candidates.length} genes in ${speciesStr}.`,
            recovery: ambiguityGuidance(symbol, speciesStr, alias.candidates),
            candidates: alias.candidates,
          });
        } else if (alias?.kind === 'unavailable') {
          failed.push({
            query: symbol,
            reason: 'unavailable',
            error: `Synonym lookup for ${symbol} got no answer from Ensembl: ${alias.error.message}`,
            recovery: UNAVAILABLE_RECOVERY,
          });
        } else {
          failed.push({
            query: symbol,
            reason: 'not_found',
            error: `Symbol ${symbol} not found in Ensembl for species ${speciesStr}.`,
            recovery: notFoundRecovery,
          });
        }
      }
      if (omitted.length)
        ctx.enrich.notice(
          `${omitted.length} distinct queries were not attempted. Resubmit batch.omitted in another call; each call resolves at most 20 distinct queries.`,
        );
      return { batch: { succeeded, failed, omitted } };
    }

    // --- Single symbol ---
    if (input.symbol?.trim()) {
      const symbol = input.symbol.trim();
      const speciesStr = input.species?.trim() || 'homo_sapiens';
      const gene = await service
        .lookupGene(symbol, speciesStr, input.expand_transcripts, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (DIRECT_MISS.test(msg)) return;
          if (/not found|no stable id|no results/i.test(msg)) {
            throw ctx.fail(
              'not_found',
              `Gene symbol "${input.symbol}" not found in ${speciesStr}.`,
            );
          }
          if (/species|invalid|unrecognized/i.test(msg)) {
            throw ctx.fail('invalid_species', `Species "${speciesStr}" not recognized by Ensembl.`);
          }
          throw err;
        });
      if (gene) return { gene };

      const alias = (
        await service.resolveSymbolAliases([symbol], speciesStr, input.expand_transcripts, ctx)
      ).get(symbol);
      // Alone, an unanswered lookup is the whole call's answer, so it fails as itself.
      if (alias?.kind === 'unavailable') throw alias.error;
      if (alias?.kind === 'gene') return { gene: { ...alias.gene, matchedAlias: symbol } };
      if (alias?.kind === 'ambiguous') {
        return {
          ambiguous: {
            query: symbol,
            candidates: alias.candidates,
            guidance: ambiguityGuidance(symbol, speciesStr, alias.candidates),
          },
        };
      }
      throw ctx.fail('not_found', `Gene symbol "${input.symbol}" not found in ${speciesStr}.`);
    }

    // --- Single ID ---
    if (input.id?.trim()) {
      const gene = await service
        .lookupGeneById(input.id.trim(), input.expand_transcripts, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found|no stable id/i.test(msg)) {
            throw ctx.fail('not_found', `Gene ID "${input.id}" not found in Ensembl.`);
          }
          throw err;
        });
      return { gene };
    }

    throw ctx.fail('no_input', 'Provide symbol (with species), id, ids, or symbols.');
  },

  format: (result) => {
    const lines: string[] = [];

    type GeneItem = NonNullable<(typeof result)['gene']> & { query?: string };
    const renderGene = (g: GeneItem, level: 2 | 3 | 4 = 2) => {
      lines.push(renderHeading(level, g.displayName ?? g.id));
      lines.push(`**ID:** ${escapeMarkdownInline(g.id)}`);
      if (g.canonicalTranscript)
        lines.push(`**Canonical transcript:** ${escapeMarkdownInline(g.canonicalTranscript)}`);
      if (g.parentGeneId) lines.push(`**Parent gene:** ${escapeMarkdownInline(g.parentGeneId)}`);
      if (g.query) lines.push(`**Query:** ${escapeMarkdownInline(g.query)}`);
      if (g.matchedAlias) lines.push(`**Matched alias:** ${escapeMarkdownInline(g.matchedAlias)}`);
      if (g.species) lines.push(`**Species:** ${escapeMarkdownInline(g.species)}`);
      if (g.biotype) lines.push(`**Biotype:** ${escapeMarkdownInline(g.biotype)}`);
      if (g.description) lines.push(`**Description:** ${escapeMarkdownInline(g.description)}`);
      if (g.chromosome) lines.push(`**Chromosome:** ${escapeMarkdownInline(g.chromosome)}`);
      if (g.start != null) lines.push(`**Start:** ${g.start}`);
      if (g.end != null) lines.push(`**End:** ${g.end}`);
      if (g.strand != null)
        lines.push(`**Strand:** ${g.strand} (${g.strand === -1 ? 'reverse' : 'forward'})`);
      if (g.assemblyName) lines.push(`**Assembly:** ${escapeMarkdownInline(g.assemblyName)}`);
      if (g.transcripts?.length) {
        lines.push(`\n**Transcripts (${g.transcripts.length}):**`);
        for (const t of g.transcripts) {
          const canon = t.isCanonical ? ' ★ canonical' : '';
          const loc =
            t.start != null && t.end != null
              ? ` ${t.start}-${t.end}${t.strand != null ? `:${t.strand}` : ''}`
              : '';
          const len = t.lengthInBp != null ? ` ${t.lengthInBp}bp` : '';
          lines.push(
            `- ${escapeMarkdownInline(t.id)}${t.displayName ? ` (${escapeMarkdownInline(t.displayName)})` : ''}${canon}${t.maneSelect ? ` | MANE Select: ${escapeMarkdownInline(t.maneSelect)}` : ''}${t.biotype ? ` [${escapeMarkdownInline(t.biotype)}]` : ''}${loc}${len}`,
          );
        }
      }
    };

    if (result.gene) {
      renderGene(result.gene);
    }
    if (result.ambiguous) {
      const { query, candidates, guidance } = result.ambiguous;
      lines.push(renderHeading(2, `Ambiguous symbol: ${query}`));
      lines.push(escapeMarkdownInline(guidance));
      for (const c of candidates) {
        lines.push('');
        renderGene(c, 3);
      }
    }
    if (result.batch) {
      const { succeeded, failed, omitted } = result.batch;
      lines.push(`## Batch Lookup Results`);
      lines.push(`**Succeeded:** ${succeeded.length} | **Failed:** ${failed.length}\n`);
      for (const g of succeeded) {
        renderGene(g);
        lines.push('');
      }
      if (failed.length > 0) {
        lines.push('### Failed lookups');
        for (const f of failed) {
          lines.push(
            `- **${escapeMarkdownInline(f.query)}** (${escapeMarkdownInline(f.reason)}): ${escapeMarkdownInline(f.error)}`,
          );
          for (const c of f.candidates ?? []) {
            lines.push('');
            renderGene(c, 4);
          }
          if (f.candidates?.length) lines.push('');
        }
        lines.push('\n### Recovery');
        for (const recovery of new Set(failed.map((f) => f.recovery))) {
          lines.push(`- ${escapeMarkdownInline(recovery)}`);
        }
      }
      if (omitted.length) {
        lines.push(`\n### Omitted (${omitted.length}) — not attempted`);
        for (const query of omitted) lines.push(`- ${escapeMarkdownInline(query)}`);
        lines.push('Resubmit these queries in another call.');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
