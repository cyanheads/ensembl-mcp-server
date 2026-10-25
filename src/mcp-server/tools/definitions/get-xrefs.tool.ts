/**
 * @fileoverview Tool to retrieve cross-database references for Ensembl genes and features.
 * @module mcp-server/tools/definitions/get-xrefs
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { renderHeading } from '@/mcp-server/tools/render-heading.js';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

const XrefEntrySchema = z.object({
  dbname: z
    .string()
    .optional()
    .describe(
      'Database name in Ensembl internal format (e.g. HGNC, Uniprot_gn, EntrezGene, MIM_GENE, RefSeq_mRNA).',
    ),
  dbDisplayName: z.string().optional().describe('Human-readable database display name.'),
  primaryId: z
    .string()
    .optional()
    .describe(
      'Primary identifier in the external database (e.g. HGNC:1101 for BRCA2 in HGNC, ' +
        'P51587 for BRCA2 in UniProt).',
    ),
  displayId: z
    .string()
    .optional()
    .describe('Display identifier — often the same as primaryId but may be a formatted accession.'),
  description: z.string().optional().describe('Description of the cross-reference entry.'),
});

export const ensemblGetXrefs = tool('ensembl_get_xrefs', {
  title: 'Get Cross-Database References',
  description:
    'Retrieve cross-database references for a gene or feature — HGNC, UniProt, EntrezGene, OMIM, ' +
    'RefSeq, Reactome, and others. Returns each xref with its database name, primary ID, display ID, ' +
    'and description. By default only the requested object level is queried; all_levels=true ' +
    'includes transcript and translation references for a gene. The dbname filter narrows this scope. ' +
    'IDs returned here chain to protein (pubchem via UniProt), literature (pubmed via PubMed IDs), ' +
    'disease (OMIM via MIM_GENE), and pathway (Reactome) resources. ' +
    'Requires an Ensembl stable ID — use ensembl_lookup_gene to get the ENSG… ID first. ' +
    'Common dbname values: HGNC, Uniprot_gn, EntrezGene, MIM_GENE, RefSeq_mRNA, RefSeq_peptide, ' +
    'Reactome_gene (gene pathways), Reactome (translation pathways), GO (Gene Ontology), ChEMBL.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Ensembl stable gene (ENSG…), transcript (ENST…), or translation (ENSP…) ID. A version suffix on an ENS… ID ' +
          '(ENSG00000139618.17) is dropped before the request. ' +
          'Use ensembl_lookup_gene to get the stable ID from a gene symbol. ' +
          'References default to this object level; all_levels=true includes child objects.',
      ),
    dbname: z
      .string()
      .optional()
      .describe(
        'Filter to a specific external database by its Ensembl internal name. ' +
          'Examples: HGNC (HGNC gene ID), Uniprot_gn (UniProt gene name), ' +
          'EntrezGene (NCBI Gene ID), MIM_GENE (OMIM disease gene), ' +
          'RefSeq_mRNA (NCBI RefSeq transcript), Reactome_gene (gene pathways), Reactome (translation pathways), ' +
          'GO (Gene Ontology terms). Transcript/translation references may require all_levels=true ' +
          'or the specific feature ID. Omit to return every database within the selected scope.',
      ),
    all_levels: z
      .boolean()
      .default(false)
      .describe(
        'Include references on child objects: a gene includes its transcripts and translations. ' +
          'Default false queries only the requested object level, independently of dbname.',
      ),
  }),
  output: z.object({
    xrefs: z
      .array(
        XrefEntrySchema.describe(
          'A single cross-database reference entry with database name, primary ID, and description.',
        ),
      )
      .describe('Cross-database references for the queried Ensembl ID.'),
    totalCount: z.number().describe('Total number of cross-references returned.'),
    queriedId: z
      .string()
      .describe('The Ensembl stable ID as submitted, including any version suffix.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no cross-references are found.'),
  },

  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Ensembl stable ID was not found. An empty cross-reference list remains successful.',
      recovery:
        'Use ensembl_lookup_gene to verify the stable ID is current and valid. ' +
        'A version suffix is already dropped from an ENS… ID, so an ID still not found is ' +
        'mistyped or retired.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting xrefs', { id: input.id, dbname: input.dbname });
    const service = getEnsemblService();

    const xrefs = await service
      .getXrefsById(input.id.trim(), input.dbname?.trim() || undefined, ctx, input.all_levels)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(msg)) {
          throw ctx.fail('not_found', `ID "${input.id}" not found in Ensembl.`);
        }
        throw err;
      });

    if (xrefs.length === 0) {
      const filterNote = input.dbname ? ` with dbname filter "${input.dbname}"` : '';
      ctx.enrich.notice(
        `No cross-references found for ${input.id}${filterNote}. ` +
          (input.all_levels
            ? 'Try a more specific feature ID or remove the dbname filter within this scope.'
            : 'Try all_levels=true to include child-object references, or a more specific feature ID. ' +
              'Remove the dbname filter to see other databases within this scope.'),
      );
    }
    ctx.enrich.total(xrefs.length);

    return { xrefs, totalCount: xrefs.length, queriedId: input.id };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(renderHeading(2, `Cross-References for ${result.queriedId}`));
    lines.push(`**Total:** ${result.totalCount}\n`);

    if (result.xrefs.length === 0) {
      lines.push('No cross-references found.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    // Group by database for readability
    const byDb = new Map<string, typeof result.xrefs>();
    for (const x of result.xrefs) {
      const db = x.dbname ?? 'Unknown';
      if (!byDb.has(db)) byDb.set(db, []);
      byDb.get(db)?.push(x);
    }

    for (const [db, entries] of byDb) {
      const displayName = entries[0]?.dbDisplayName;
      lines.push(
        renderHeading(
          3,
          `${displayName ?? db}${displayName && displayName !== db ? ` (${db})` : ''}`,
        ),
      );
      for (const x of entries) {
        let line = `- **${escapeMarkdownInline(x.primaryId ?? x.displayId ?? 'unknown')}**`;
        if (x.displayId && x.displayId !== x.primaryId)
          line += ` (${escapeMarkdownInline(x.displayId)})`;
        if (x.description) line += `: ${escapeMarkdownInline(x.description)}`;
        lines.push(line);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
