---
name: ensembl-guide
description: Gates and identifier chains for the ensembl_* tools. Covers checking a coordinate's assembly before you pass it in, finding a gene's counterpart in another species through homology, reading multi-allelic and capped VEP results, and which Ensembl object holds the UniProt, RefSeq, GO, and PDB references. Use when an ensembl_* result feeds a conclusion about a gene, variant, ortholog, or external ID.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Ensembl REST, keyless: genes, transcripts, sequences, features overlapping a region, VEP consequences, Compara homology, and external references. The default endpoint serves vertebrates plus the plant, fungal, metazoan, and protist genomes; ensembl_list_species lists a non-vertebrate division only when you pass that division.

Not here: population allele frequencies (colocated VEP records carry IDs, clinical significance, and PubMed IDs, no frequencies), allele-level clinical classification, protein function and domains, 3D structures, and sequence similarity search. Get frequencies from a gnomAD source, function from UniProt, and structures from a PDB source. Use the Ensembl IDs from here as keys into those sources.

## Identifiers

| ID | Where it comes from | What accepts it |
|:---|:--------------------|:----------------|
| `ENSG…` gene | ensembl_lookup_gene (symbol, alias, or ID); gene rows from ensembl_query_region; `geneId` on VEP consequences; `targetId` on homologs | ensembl_lookup_gene, ensembl_get_homology, ensembl_get_xrefs, ensembl_get_sequence (genomic only) |
| `ENST…` transcript | `canonicalTranscript` from ensembl_lookup_gene, or its transcript list; `transcriptId` on VEP consequences | ensembl_lookup_gene, ensembl_get_sequence (cdna, cds, protein), ensembl_get_xrefs, transcript HGVS for ensembl_predict_variant |
| `ENSP…` translation | `targetProteinId` on homologs; the `id` of an ensembl_get_sequence protein result fetched through the `ENST…`; `hgvsp` on VEP consequences | ensembl_get_sequence (protein), ensembl_get_xrefs |
| rsID | variation rows from ensembl_query_region; colocated variants on VEP results | ensembl_predict_variant |
| RefSeq `NM_…` | `maneSelect` on expanded transcripts from ensembl_lookup_gene; `RefSeq_mRNA` references on the transcript | other servers |
| UniProt accession | `Uniprot/SWISSPROT` reference on the translation (see the xref gate) | other servers |

## Gates

**Confirm the assembly before you pass a coordinate.** Every coordinate this server reads or returns is on the assembly it reports as `assemblyName` (GRCh38 for human on the default endpoint). The server does not reject a GRCh37/hg19 position. It reads it as GRCh38, where it lands on other genes: BRCA2's GRCh37 locus, queried here, returns a lncRNA and a pseudogene, not BRCA2. Before you use a position from a paper, a VCF, a clinical report, or a genome browser, confirm which build it is on. For a GRCh37 variant, enter through its rsID or a transcript HGVS instead, and the server places it on its own assembly. A genomic HGVS (`g.`) states its reference base, so VEP rejects it where that base differs. Region+allele input states no reference base, so VEP annotates it wherever it lands.

**Coordinates are 1-based and inclusive.** `start` and `end` are both in the region: 17:7661779-7661798 is 20 bases. Add 1 to the start of a BED interval, which is 0-based and half-open, before you pass it.

**Check the transcript version in an HGVS string.** A transcript HGVS with an older version (`ENST00000380152.7:c.…` when `.8` is current) is annotated against the current transcript, with no warning. When the version matters, compare it with `canonicalTranscript` from ensembl_lookup_gene.

**Find a gene's counterpart in another species with ensembl_get_homology, not by looking up the human symbol there.** A symbol lookup in another species only matches names. Human TP53 in mouse resolves to Trp53 through a synonym. Human SOX9 in zebrafish returns `not_found`, although zebrafish has two SOX9 orthologs.

**Set `target_species` once for each organism you care about.** Without it, ensembl_get_homology returns one capped page in Ensembl's order, which starts with primates. Human TP53's mouse and zebrafish orthologs both fall outside the default page. `totalCount` is the full match count; compare it with the rows shown.

**Read the homology `type` before you name "the ortholog".** `ortholog_one2many` and `ortholog_many2many` mean the relationship is not 1:1. Report every row for the target species, ranked by `percId` if you need an order. For example, human SOX9 maps to two zebrafish genes, both `one2many`.

**Query homology from the vertebrate side.** A non-vertebrate gene's homology search runs against its own division. From a fly gene, `target_species: homo_sapiens` fails because Ensembl has no genome named `homo_sapiens` there. From the human gene, `target_species: drosophila_melanogaster` returns the fly ortholog.

**Set the species to match a non-human gene ID in ensembl_get_homology.** That tool defaults the species to `homo_sapiens` even when you pass an ID. A mouse `ENSMUSG…` ID with the default species fails as `not_found … in homo_sapiens`. Every other tool infers the species from the ID.

**Filter VEP results to the allele you mean.** One rsID can carry several alternate alleles. rs334 is `T/A/C/G`, and each allele gets its own transcript consequences. Every consequence names its `variantAllele`, and `mostSevereConsequence` covers all the alleles together. Filter to the allele in question before you report a consequence, an HGVS string, or a SIFT/PolyPhen score.

**Confirm the canonical consequence made it past the cap.** The cap on transcript consequences keeps Ensembl's order: by transcript ID, with alleles interleaved, not canonical-first. For a large gene such as TTN, the canonical transcript can sit well past the default cap of 10. A multi-allelic rsID fills the cap with fewer transcripts. Before you report the consequence on the canonical transcript, find a returned row for your gene (`geneId` or `geneSymbol`) with `canonical` or `maneSelect` set; other genes overlapping the same variant carry canonical transcripts of their own. If there isn't one, call again with the cap at 0.

**Request references at the object level that holds them.** A gene's own references don't include RefSeq, GO, CCDS, PDB, or the reviewed UniProt entry. Gene-level `Uniprot_gn` lists every UniProt accession tagged with the gene name, reviewed and unreviewed, all with the same description. `RefSeq_mRNA`, GO, and CCDS sit on the transcript itself. The Swiss-Prot accession (`Uniprot/SWISSPROT`), `RefSeq_peptide`, and PDB sit on the translation: call ensembl_get_xrefs on the canonical transcript with `all_levels`, which returns both levels, or on the `ENSP…`. An empty result for one of these databases at gene level tells you nothing about whether the reference exists.

**Fetch both sequences on the same strand before you compare them.** Genomic sequence fetched by gene or transcript ID comes back in the feature's own orientation, so a reverse-strand gene arrives reverse-complemented. A region comes back on the forward strand unless you add `:-1`. The two outputs match only if you request them on the same strand.
