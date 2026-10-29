/**
 * @fileoverview Prompt for assembling a complete gene profile using the Ensembl tool chain.
 * @module mcp-server/prompts/definitions/gene-dossier
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

const MODEL_ORGANISMS = ['mus_musculus', 'rattus_norvegicus', 'danio_rerio'] as const;

/** Step 5's quoted target species: the model organisms, with homo_sapiens in place of the source species. */
const orthologTargets = (species: string) =>
  MODEL_ORGANISMS.map((s) => `"${s === species ? 'homo_sapiens' : s}"`).join(', ');

export const ensemblGeneDossierPrompt = prompt('ensembl_gene_dossier', {
  description:
    'Structured research workflow for assembling a complete gene profile. Guides the agent through the Ensembl tool chain in order: symbol → ID + location → protein sequence → key variants → model-organism orthologs → external database IDs for protein and disease follow-up.',
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
          'Default is homo_sapiens. Use ensembl_list_species with nameContains (e.g. "mouse") to ' +
          'find a valid value.',
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
          `biotype, and canonicalTranscript (the canonical ENST… ID). Record transcript maneSelect ` +
          `when available. If the symbol is a synonym, the gene ` +
          `carries matchedAlias and displayName is its current name. If the result is ambiguous ` +
          `instead of gene, the symbol names several genes: pick the candidate that fits the ` +
          `research question by description and location, call \`ensembl_lookup_gene\` again with ` +
          `its id and expand_transcripts=true, and use that stable ID wherever a later step ` +
          `names the symbol.\n\n` +
          `2. **Fetch the protein sequence** — call \`ensembl_get_sequence\` with the canonical ` +
          `transcript ID from step 1 and type="protein". Record the amino acid sequence and its length. ` +
          `A protein longer than 10,000 residues comes back as a first window (truncated=true); length ` +
          `is still the full length, and the window already holds the leading residues step 7 needs.\n\n` +
          `3. **Find variants in the locus** — call \`ensembl_query_region\` with ` +
          `species="${args.species}", the gene's chromosomal region (chr:start-end from step 1), ` +
          `and feature=["variation"]. A gene locus can hold tens of thousands of variants, so the ` +
          `response returns the first 100 (max_results) while totalCount reports the full count — ` +
          `record totalCount as the locus variant count. To see other variants, query a narrower ` +
          `window (e.g. one exon's coordinates) or raise max_results. Record the variant IDs (rsIDs), ` +
          `positions, consequence type, and any clinical significance of the returned variants. ` +
          `Functional impact (HIGH/MODERATE/LOW) is not reported by this step — it comes from VEP ` +
          `in step 4.\n\n` +
          `4. **Predict variant consequences** — for up to 3 variants from step 3, ` +
          `call \`ensembl_predict_variant\` with each variant's rsID (e.g. rs334), HGVS notation, ` +
          `or region+allele. This step returns the functional impact. ` +
          `Record mostSevereConsequence, impact, variantAllele, canonical, and maneSelect when present. ` +
          `Clinical significance is aggregate for a colocated record; use clinicalSignificanceByAllele ` +
          `for explicit allele attribution, never infer it for the submitted allele.\n\n` +
          `5. **Find model-organism orthologs** — call \`ensembl_get_homology\` three times, with ` +
          `symbol="${args.gene_symbol}", species="${args.species}", type="orthologues", and ` +
          `target_species set to each of ${orthologTargets(args.species)} in turn. Without target_species the ` +
          `tool returns one capped page in Ensembl's order, which can leave out all three. For every ` +
          `returned row, record type, targetId, targetSymbol and targetProteinId when present, and ` +
          `percId; if totalCount exceeds the rows shown, repeat that call with max_results=0. ` +
          `When type is ortholog_one2many or ortholog_many2many, the gene has several orthologs in ` +
          `that species: report every row for it, ranked by percId, instead of naming one. Missing ` +
          `targetSymbol does not imply no homolog. A call that returns no rows means Ensembl records ` +
          `no ortholog in that species; record a failed call with its error reason, not as a ` +
          `missing ortholog.\n\n` +
          `6. **Get external database IDs** — call \`ensembl_get_xrefs\` twice:\n` +
          `   - The stable gene ID from step 1, with no dbname and all_levels left false. Record the ` +
          `HGNC ID (dbname=HGNC; a non-human gene carries its own nomenclature ID instead, such as ` +
          `MGI for mouse), NCBI Gene ID (dbname=EntrezGene), and OMIM gene ID (dbname=MIM_GENE) when present.\n` +
          `   - The canonical transcript ID from step 1, with all_levels=true and ` +
          `dbname="Uniprot/SWISSPROT". Record its primaryId as the reviewed UniProt accession. ` +
          `An empty result means no reviewed UniProt entry is linked: record that, and don't ` +
          `substitute an unreviewed accession.\n` +
          `   Take the RefSeq transcript from step 1's maneSelect when present; it needs no call. ` +
          `Never pass the gene ID with all_levels=true: that returns every transcript's references, ` +
          `thousands of rows for a well-studied gene.\n\n` +
          `7. **Synthesize the dossier** — compile your findings into a structured report with sections:\n` +
          `   - Gene overview (ID, location, biotype, description)\n` +
          `   - Protein sequence summary (length, first 50 aa, key domains if known)\n` +
          `   - Variant landscape (count from step 3's totalCount, highest-impact findings, ` +
          `clinical significance)\n` +
          `   - Conservation across species (every ortholog row from step 5 with its type and percId)\n` +
          `   - External IDs for follow-up (the IDs from steps 1 and 6) and where each leads: ` +
          `UniProt accession → UniProt for function and PubChem for bioassays; gene symbol → PubMed ` +
          `search for literature; MIM_GENE → OMIM for disease\n\n` +
          `Use the stable IDs and coordinates from each step as inputs to the next — ` +
          `the Ensembl tool chain is designed to chain this way.`,
      },
    },
  ],
});
