/**
 * @fileoverview Tool to resolve genes by symbol + species or by Ensembl stable ID.
 * @module mcp-server/tools/definitions/lookup-gene
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const TranscriptSummarySchema = z.object({
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

const GeneResultSchema = z.object({
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

const BatchResultSchema = z.object({
  // passthrough() — fields rendered via format()'s renderGene helper, not individually listed.
  succeeded: z
    .array(
      z
        .object({})
        .passthrough()
        .describe('A resolved gene record with the same shape as the gene output field.'),
    )
    .describe('Gene records for IDs/symbols that resolved successfully. Same shape as gene.'),
  failed: z
    .array(
      z
        .object({})
        .passthrough()
        .describe(
          'A failed lookup entry with query (the submitted ID or symbol) and error (reason string) fields.',
        ),
    )
    .describe('IDs/symbols that could not be resolved, with per-item query and error fields.'),
});

export const ensemblLookupGene = tool('ensembl_lookup_gene', {
  title: 'Lookup Gene',
  description:
    'Resolve a gene by symbol + species (or by stable ID) to its Ensembl ID, genomic location ' +
    '(chr:start-end:strand), biotype, description, and transcript list. Entry point for most workflows — ' +
    'the stable ID and coordinates returned here are inputs to other tools. Accepts both symbol lookup ' +
    '(BRCA2 + homo_sapiens) and direct ID lookup (ENSG00000139618). Supports batch lookup of up to 20 ' +
    'IDs or symbols in one call via the ids or symbols field. For symbol lookup, species is required; ' +
    'for ID lookup, species is not needed. Use ensembl_list_species to discover valid species names.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    symbol: z
      .string()
      .optional()
      .describe(
        'Gene symbol to look up (e.g. BRCA2, TP53, EGFR). ' +
          'Requires species to be set. Case-insensitive in most species.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Ensembl stable gene ID (e.g. ENSG00000139618 or ENSG00000139618.7 with version). ' +
          'Species is not required for ID lookup.',
      ),
    species: z
      .string()
      .optional()
      .describe(
        'Species in Ensembl internal format: lowercase scientific name with underscores ' +
          '(e.g. homo_sapiens, mus_musculus, danio_rerio). ' +
          'Required when using symbol. Default is homo_sapiens for symbol-based lookups. ' +
          'Use ensembl_list_species to discover valid values.',
      ),
    ids: z
      .array(
        z.string().describe('An Ensembl stable gene or transcript ID to resolve in this batch.'),
      )
      .max(20)
      .optional()
      .describe(
        'Batch lookup: up to 20 Ensembl stable IDs (ENSG…, ENST…). ' +
          'Returns a succeeded/failed split. Cannot be combined with symbol or id.',
      ),
    symbols: z
      .array(z.string().describe('A gene symbol to resolve in this batch (e.g. BRCA2, TP53).'))
      .max(20)
      .optional()
      .describe(
        'Batch lookup: up to 20 gene symbols. ' +
          'Requires species to be set. Returns a succeeded/failed split. ' +
          'Cannot be combined with symbol, id, or ids.',
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
      'Single gene record. Present for symbol or id lookups.',
    ),
    batch: BatchResultSchema.optional().describe(
      'Batch results. Present for ids or symbols lookups.',
    ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The gene symbol or stable ID was not found in Ensembl.',
      recovery:
        'Verify the symbol spelling or ID format. Use ensembl_list_species to confirm the species name, ' +
        'then retry. Stable IDs are versioned (ENSG00000139618.7) — omitting the version resolves to current.',
    },
    {
      reason: 'invalid_species',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The species string was not recognized by Ensembl.',
      recovery:
        'Call ensembl_list_species to discover valid species names. ' +
        'Species must be in lowercase_underscore format (homo_sapiens, not Human or Homo Sapiens).',
    },
    {
      reason: 'no_input',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither symbol, id, ids, nor symbols was provided.',
      recovery:
        'Provide exactly one of: symbol (with species), id, ids array, or symbols array (with species).',
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

    // --- Batch by IDs ---
    if (input.ids?.length) {
      const map = await service.lookupGenesBatch(input.ids, input.expand_transcripts, ctx);
      const succeeded = Array.from(map.values());
      const resolvedIds = new Set(map.keys());
      const failed = input.ids
        .filter((id) => !resolvedIds.has(id))
        .map((id) => ({ query: id, error: `ID ${id} not found in Ensembl.` }));
      return { batch: { succeeded, failed } };
    }

    // --- Batch by symbols ---
    if (input.symbols?.length) {
      const speciesStr = input.species?.trim() || 'homo_sapiens';
      const map = await service.lookupSymbolsBatch(
        input.symbols,
        speciesStr,
        input.expand_transcripts,
        ctx,
      );
      const succeeded = Array.from(map.values());
      const resolvedSymbols = new Set(map.keys());
      const failed = input.symbols
        .filter((s) => !resolvedSymbols.has(s))
        .map((s) => ({
          query: s,
          error: `Symbol ${s} not found in Ensembl for species ${speciesStr}.`,
        }));
      return { batch: { succeeded, failed } };
    }

    // --- Single symbol ---
    if (input.symbol?.trim()) {
      const speciesStr = input.species?.trim() || 'homo_sapiens';
      const gene = await service
        .lookupGene(input.symbol.trim(), speciesStr, input.expand_transcripts, ctx)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found|no stable id|no results|no valid lookup/i.test(msg)) {
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
      return { gene };
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

    type GeneItem = NonNullable<(typeof result)['gene']>;
    const renderGene = (g: GeneItem) => {
      lines.push(`## ${g.displayName ?? g.id}`);
      lines.push(`**ID:** ${g.id}`);
      if (g.species) lines.push(`**Species:** ${g.species}`);
      if (g.biotype) lines.push(`**Biotype:** ${g.biotype}`);
      if (g.description) lines.push(`**Description:** ${g.description}`);
      if (g.chromosome) lines.push(`**Chromosome:** ${g.chromosome}`);
      if (g.start != null) lines.push(`**Start:** ${g.start}`);
      if (g.end != null) lines.push(`**End:** ${g.end}`);
      if (g.strand != null)
        lines.push(`**Strand:** ${g.strand} (${g.strand === -1 ? 'reverse' : 'forward'})`);
      if (g.assemblyName) lines.push(`**Assembly:** ${g.assemblyName}`);
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
            `- ${t.id}${t.displayName ? ` (${t.displayName})` : ''}${canon}${t.biotype ? ` [${t.biotype}]` : ''}${loc}${len}`,
          );
        }
      }
    };

    if (result.gene) {
      renderGene(result.gene);
    } else if (result.batch) {
      const { succeeded, failed } = result.batch;
      lines.push(`## Batch Lookup Results`);
      lines.push(`**Succeeded:** ${succeeded.length} | **Failed:** ${failed.length}\n`);
      for (const g of succeeded) {
        renderGene(g as GeneItem);
        lines.push('');
      }
      if (failed.length > 0) {
        lines.push('### Failed lookups');
        for (const f of failed) {
          lines.push(`- **${f.query}:** ${f.error}`);
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
