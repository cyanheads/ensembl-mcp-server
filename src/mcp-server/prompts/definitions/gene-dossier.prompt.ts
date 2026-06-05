/**
 * @fileoverview Prompt for assembling a complete gene profile using the Ensembl tool chain.
 * @module mcp-server/prompts/definitions/gene-dossier
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const ensemblGeneDossierPrompt = prompt('ensembl_gene_dossier', {
  description:
    'Structured research workflow for assembling a complete gene profile. Guides the agent through ' +
    'the Ensembl tool chain in order: symbol → ID + location → protein sequence → key variants → ' +
    'cross-species orthologs → xref IDs for protein and literature follow-up.',
  args: z.object({
    gene_symbol: z
      .string()
      .describe(
        'Gene symbol to research (e.g. BRCA2, TP53, EGFR). ' +
          'Case-insensitive; Ensembl will resolve the canonical form.',
      ),
    species: z
      .string()
      .default('homo_sapiens')
      .describe(
        'Species in Ensembl internal format (e.g. homo_sapiens, mus_musculus). ' +
          'Default is homo_sapiens. Use ensembl_list_species to discover valid values.',
      ),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text:
          `Assemble a complete gene profile for **${args.gene_symbol}** in **${args.species}** ` +
          `using the Ensembl MCP tools. Follow these steps in order:\n\n` +
          `1. **Resolve the gene** — call \`ensembl_lookup_gene\` with symbol="${args.gene_symbol}" ` +
          `and species="${args.species}", setting expand_transcripts=true. ` +
          `Record the stable ID (ENSG…), genomic coordinates (chr:start-end:strand:assembly), ` +
          `biotype, and the canonical transcript ID (ENST…).\n\n` +
          `2. **Fetch the protein sequence** — call \`ensembl_get_sequence\` with the canonical ` +
          `transcript ID from step 1 and type="protein". Record the amino acid sequence and its length.\n\n` +
          `3. **Find variants in the locus** — call \`ensembl_query_region\` with ` +
          `species="${args.species}", the gene's chromosomal region (chr:start-end from step 1), ` +
          `and feature=["variation"]. Identify any HIGH or MODERATE impact variants.\n\n` +
          `4. **Predict variant consequences** — for up to 3 high-impact variants found in step 3, ` +
          `call \`ensembl_predict_variant\` with the variant ID or HGVS notation. ` +
          `Record most_severe_consequence, impact, and clinical significance.\n\n` +
          `5. **Find cross-species orthologs** — call \`ensembl_get_homology\` with ` +
          `symbol="${args.gene_symbol}", species="${args.species}", and type="orthologues". ` +
          `Focus on mammalian orthologs (mouse, rat, zebrafish). Record perc_id for the top 3.\n\n` +
          `6. **Get external database IDs** — call \`ensembl_get_xrefs\` with the stable gene ID ` +
          `from step 1 (no dbname filter to get all). Record: ` +
          `HGNC ID (dbname=HGNC), UniProt accession (dbname=Uniprot_gn), ` +
          `NCBI Gene ID (dbname=EntrezGene), and OMIM ID (dbname=MIM_GENE) if present.\n\n` +
          `7. **Synthesize the dossier** — compile your findings into a structured report with sections:\n` +
          `   - Gene overview (ID, location, biotype, description)\n` +
          `   - Protein sequence summary (length, first 50 aa, key domains if known)\n` +
          `   - Variant landscape (count, highest-impact findings, clinical significance)\n` +
          `   - Conservation across species (ortholog table with perc_id)\n` +
          `   - External IDs for follow-up (UniProt → pubchem for structure, ` +
          `HGNC/EntrezGene → pubmed for literature, OMIM for disease associations)\n\n` +
          `Use the stable IDs and coordinates from each step as inputs to the next — ` +
          `the Ensembl tool chain is designed to chain this way.`,
      },
    },
  ],
});
