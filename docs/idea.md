---
name: ensembl-mcp-server
description: "Genomic data via Ensembl — genes, transcripts, sequences, variants, and cross-species homology."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/ensembl-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
mirror: "not viable — reference genomes/sequences are GB–TB, far over the few-GB target; use Ensembl REST/BioMart live. A gene-symbol→stable-ID xref index could be a small T0 cache."
pattern: multi-endpoint single-source
complexity: medium
api-deps: Ensembl REST API (rest.ensembl.org)
api-cost: free (no key; ~15 req/sec rate limit)
hostable: true
composes-with: pubchem-mcp-server, pubmed-mcp-server, crossref-mcp-server
---

# ensembl-mcp-server

Genomic data via the [Ensembl REST API](https://rest.ensembl.org/) — genes, transcripts, proteins, DNA/protein sequences, genomic features, variant consequences, and cross-species homology across vertebrates and model organisms. Keyless.

The fleet has chemistry (`pubchem`), literature (`pubmed`), and crop genetics (`brapi`), but no **genomics** — the gene/genome layer that underpins modern biology and medicine. Ensembl is one of the two canonical open genome resources (with UniProt for proteins). This is the serious-bio-research gap.

**Audience:** Bioinformaticians, geneticists, molecular biologists, students, agents doing genomic lookups — "where is BRCA2 and what does it do?", "what's the protein sequence of this transcript?", "is this variant damaging?", "what's the mouse ortholog?"

## User Goals

- Resolve a gene symbol (in a species) to its stable ID, location, and function
- Get the DNA, cDNA, or protein sequence for a gene/transcript
- Find features (genes, variants, regulatory regions) in a genomic region
- Predict the consequences of a sequence variant
- Find orthologs/paralogs of a gene across species

## API Surface

Keyless REST at `rest.ensembl.org`. Genes/transcripts/proteins use **stable IDs** (`ENSG…`, `ENST…`, `ENSP…`); species by name (`homo_sapiens`); regions as `chr:start-end`. `Content-Type` negotiates JSON.

| Endpoint family | Purpose |
|:----------------|:--------|
| `/lookup/symbol/{species}/{symbol}`, `/lookup/id/{id}` | Resolve gene symbol or stable ID → location, biotype, description |
| `/sequence/id/{id}`, `/sequence/region/{species}/{region}` | DNA / cDNA / CDS / protein sequence |
| `/overlap/region/{species}/{region}?feature=` | Features overlapping a region (gene, transcript, variation, regulatory) |
| `/vep/{species}/hgvs/{notation}` | Variant Effect Predictor — consequences of a variant |
| `/homology/symbol/{species}/{symbol}` | Orthologs/paralogs across species |
| `/xrefs/symbol/{species}/{symbol}` | Cross-references (HGNC, UniProt, RefSeq, …) |

## Tool Surface (sketch)

```
ensembl_list_species   — list all species supported by Ensembl with their name, display
                         name, assembly, and division (vertebrates, plants, fungi, …).
                         Required discovery step — species names like "homo_sapiens" or
                         "mus_musculus" are the input format every other tool expects.

ensembl_lookup_gene    — resolve a gene by symbol + species (or by stable ID) to its
                         Ensembl ID, genomic location (chr:start-end, strand), biotype,
                         description, and transcript list. Required first step — most
                         other tools key on the stable ID or location.

ensembl_get_sequence   — sequence for a gene, transcript, protein, or genomic region.
                         type: genomic | cdna | cds | protein. Large sequences chunked
                         with offset/limit. "Give me the protein sequence of this
                         transcript."

ensembl_query_region   — features overlapping a genomic region: genes, transcripts,
                         variants, or regulatory elements (feature=gene|transcript|
                         variation|regulatory). "What genes are in this locus?"

ensembl_predict_variant  — Variant Effect Predictor: consequences of a variant (HGVS or
                         region/allele) — affected genes/transcripts, consequence terms
                         (missense, stop-gained, ...), and severity. "Is this variant
                         likely damaging?"

ensembl_get_homology   — orthologs and paralogs of a gene across species: the homologous
                         gene, species, type (ortholog/paralog), and % identity.
                         "What's the mouse ortholog of human TP53?"

ensembl_lookup_xrefs   — cross-references for a gene to other databases (HGNC, UniProt,
                         RefSeq, OMIM) — the IDs needed to chain to protein, literature,
                         or disease resources.
```

## Design Notes

- Medium complexity — the genomics **vocabulary** is the work: species names, stable-ID formats (ENSG/ENST/ENSP), genome assemblies (GRCh38 vs older), coordinate systems, and consequence ontology terms. Tool descriptions must teach enough that an agent (or a smaller model) supplies valid inputs.
- **Resolve-before-fetch.** `ensembl_lookup_gene` turns a human-readable symbol into the stable ID / coordinates the other tools need — make it the documented entry point.
- Sequences can be huge (a chromosome region, a long gene) — `ensembl_get_sequence` needs chunking with clear "more remaining," never silent truncation.
- **State the assembly.** Coordinates are assembly-specific (GRCh38); a position means nothing without it. Default to and echo the assembly so an agent doesn't mix builds.
- `ensembl_get_xrefs` is the chaining linchpin — the UniProt/HGNC/OMIM IDs it returns are how this server composes with protein, literature, and disease resources.
- Rate limit ~15 req/sec — the service layer should respect it (the API returns `Retry-After` on 429); batch where endpoints allow.
- Composes with `pubchem` (gene/target → bioactive compounds), `pubmed` (gene → literature via the xref IDs), `crossref` (papers behind a finding). UniProt would be the natural protein-layer sibling (future server).
- Moonshot: a "gene dossier" workflow — symbol → location, function, sequence, top variants, orthologs, and linked literature assembled in one call.
- README one-liner: "Genes, sequences, variants, and cross-species homology from Ensembl — the open genome browser for agents."
