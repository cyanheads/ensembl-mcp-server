/**
 * @fileoverview Tool to retrieve cross-database references for Ensembl genes and features.
 * @module mcp-server/tools/definitions/get-xrefs
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
    'and description. The dbname filter narrows to specific databases; omit to return all xrefs. ' +
    'IDs returned here chain to protein (pubchem via UniProt), literature (pubmed via PubMed IDs), ' +
    'disease (OMIM via MIM_GENE), and pathway (Reactome) resources. ' +
    'Requires an Ensembl stable ID — use ensembl_lookup_gene to get the ENSG… ID first. ' +
    'Common dbname values: HGNC, Uniprot_gn, EntrezGene, MIM_GENE, RefSeq_mRNA, RefSeq_peptide, ' +
    'Reactome, GO (Gene Ontology), ChEMBL.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    id: z
      .string()
      .describe(
        'Ensembl stable gene ID (ENSG…) or transcript ID (ENST…). ' +
          'Use ensembl_lookup_gene to get the stable ID from a gene symbol. ' +
          'xrefs/id returns the full cross-reference set (56+ entries for well-annotated genes like BRCA2).',
      ),
    dbname: z
      .string()
      .optional()
      .describe(
        'Filter to a specific external database by its Ensembl internal name. ' +
          'Examples: HGNC (HGNC gene ID), Uniprot_gn (UniProt gene name), ' +
          'EntrezGene (NCBI Gene ID), MIM_GENE (OMIM disease gene), ' +
          'RefSeq_mRNA (NCBI RefSeq transcript), Reactome (pathway IDs), ' +
          'GO (Gene Ontology terms). Omit to return all available xrefs.',
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
    queriedId: z.string().describe('The Ensembl stable ID that was queried.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no cross-references are found.'),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Ensembl stable ID was not found or has no cross-references.',
      recovery:
        'Use ensembl_lookup_gene to verify the stable ID is current and valid. ' +
        'Versioned IDs (ENSG00000139618.7) should work with or without the version suffix.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting xrefs', { id: input.id, dbname: input.dbname });
    const service = getEnsemblService();

    const xrefs = await service
      .getXrefsById(input.id.trim(), input.dbname?.trim() || undefined, ctx)
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
          'Try without the dbname filter to see all available databases.',
      );
    }
    ctx.enrich.total(xrefs.length);

    return { xrefs, totalCount: xrefs.length, queriedId: input.id };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Cross-References for ${result.queriedId}`);
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
      lines.push(`### ${displayName ?? db}${displayName && displayName !== db ? ` (${db})` : ''}`);
      for (const x of entries) {
        let line = `- **${x.primaryId ?? x.displayId ?? 'unknown'}**`;
        if (x.displayId && x.displayId !== x.primaryId) line += ` (${x.displayId})`;
        if (x.description) line += `: ${x.description}`;
        lines.push(line);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
