# ensembl-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ensembl_list_species` | List species supported by Ensembl with display name, common name, assembly, taxon ID, and division. Required discovery step — species names like `homo_sapiens` are opaque to non-biologists and are the input format every other tool expects. | `division` (optional enum: vertebrates, plants, fungi, metazoa, protists), `nameContains` (local filter) | `readOnlyHint`, `openWorldHint: false` |
| `ensembl_lookup_gene` | Resolve a gene by symbol + species (or by stable ID) to its Ensembl ID, genomic location (chr:start-end:strand), biotype, description, and transcript list. Entry point for most workflows — the stable ID and coordinates returned here are inputs to other tools. Accepts both symbol lookup (`BRCA2` + `homo_sapiens`) and direct ID lookup (`ENSG00000139618`). Supports batch lookup of up to 20 IDs or symbols in one call. Errors: `not_found` (symbol or ID not in Ensembl), `invalid_species` (species string not recognized — call `ensembl_list_species` to discover valid names). | `symbol` or `id` (one required), `species` (required when using `symbol`), `expand_transcripts` (bool), `ids` (batch array, up to 20) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_get_sequence` | Fetch the DNA, cDNA, CDS, or protein sequence for a gene, transcript, protein, or genomic region. Returns the sequence with its stable ID, molecule type, and actual length — large sequences are returned in full but the character count is stated so callers can budget context. `type` controls which sequence is fetched: `genomic` (default, includes introns), `cdna` (spliced transcript), `cds` (coding sequence only), `protein`. Errors: `not_found` (ID not in Ensembl), `type_mismatch` (e.g., requesting `protein` from a gene ID — use a transcript/protein stable ID instead). | `id` (stable ID or `species:region` for region mode), `type` (enum: genomic, cdna, cds, protein), `species` (required for region mode), `expand_5prime` / `expand_3prime` (optional bp flanks) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_query_region` | Find genomic features overlapping a chromosomal region: genes, transcripts, variants, regulatory elements, or exons. Returns each feature with its stable ID, type, location, biotype, and name. Useful for "what's in this locus?" and for seeding follow-up lookups. Region format: `chr:start-end` (e.g., `13:32315086-32400268`). | `species`, `region` (chr:start-end), `feature` (enum array: gene, transcript, variation, regulatory, exon; default: gene), `biotype` (optional filter) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_predict_variant` | Predict the functional consequences of a sequence variant using the Ensembl Variant Effect Predictor (VEP). Accepts HGVS notation (transcript-relative, e.g., `ENST00000380152.8:c.2T>A`) or genomic HGVS, and also region+allele format (`chr:start:end:strand/allele`, e.g., `1:65568:65568:1/T`). Returns the most severe consequence term, affected transcripts and genes, impact level (HIGH/MODERATE/LOW/MODIFIER), and any colocated known variants with clinical significance. Errors: `invalid_notation` (unparseable HGVS or region string — check format), `not_found` (variant location outside any known transcript). | `variant` (HGVS notation or `chr:start:end:strand/allele`), `species` (default: `homo_sapiens`) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_get_homology` | Find orthologs and/or paralogs of a gene across species. Returns each homolog's stable ID, species, type (ortholog_one2one, ortholog_one2many, paralog_many2many, etc.), `perc_id` (percent identity), `perc_pos` (percent positives), and taxonomy level. Essential for cross-species research — "what is the mouse equivalent of human TP53?" | `symbol` or `id` (one required), `species` (source species, default: `homo_sapiens`), `target_species` (optional filter), `type` (enum: orthologues, paralogues, all; default: orthologues) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_get_xrefs` | Retrieve cross-database references for a gene or feature — HGNC, UniProt, EntrezGene, OMIM, RefSeq, Reactome, and others. Returns each xref with its database name, primary ID, display ID, and description. The `dbname` filter narrows to specific databases. IDs returned here chain to protein (`pubchem`), literature (`pubmed`), disease, and pathway resources. | `id` (Ensembl stable ID), `dbname` (optional filter, e.g., `HGNC`, `Uniprot_gn`, `EntrezGene`, `MIM_GENE`), `external_db` (alias for `dbname`) | `readOnlyHint`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ensembl://gene/{id}` | Gene record by stable ID (`ENSG…`). Returns location, biotype, description, and transcript list. Stable, injectable context for multi-step workflows. | None needed — single entity |
| `ensembl://transcript/{id}` | Transcript record by stable ID (`ENST…`). Returns parent gene, location, biotype, canonical flag, and length. | None needed — single entity |
| `ensembl://species` | List of all supported Ensembl species with name, display name, assembly, taxon ID, and division. Addressable reference for tool bootstrapping. | Cursor — 348 vertebrate species + non-vertebrate divisions |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `ensembl_gene_dossier` | Structured research workflow for assembling a complete gene profile: symbol → ID + location → sequence → key variants → cross-species orthologs → xref IDs for protein and literature follow-up. Guides the agent through the tool chain in order. | `gene_symbol`, `species` (default: `homo_sapiens`) |

---

## Overview

ensembl-mcp-server exposes the [Ensembl REST API](https://rest.ensembl.org/) as a genomics MCP layer — genes, transcripts, sequences, variant consequences, and cross-species homology across vertebrates and model organisms. No API key required.

The fleet has chemistry (`pubchem`), literature (`pubmed`), and crop genetics (`brapi`) but no vertebrate genomics layer. Ensembl is one of the two canonical open genome resources (alongside UniProt for proteins). This server fills that gap: the gene/genome foundation that underpins modern biology and medicine.

**Audience:** Bioinformaticians, geneticists, molecular biologists, students, agents doing genomic lookups — "where is BRCA2 and what does it do?", "what's the protein sequence of this transcript?", "is this variant damaging?", "what's the mouse ortholog?"

---

## Requirements

- Keyless REST at `https://rest.ensembl.org`. `Accept: application/json` header required — server defaults to XML otherwise.
- Rate limit: 55,000 req/hr (not ~15 req/sec as docs imply — confirmed via `x-ratelimit-limit` headers). The API returns `x-ratelimit-remaining`, `x-ratelimit-reset`, and `x-ratelimit-period` headers on every response. Honor 429 responses with `Retry-After`.
- All coordinates are assembly-specific. Default assembly is GRCh38 for human. The assembly name is echoed in every response that contains coordinates so the agent never sees a bare position without assembly context.
- Stable IDs use versioned format: `ENSG00000139618.7` (gene), `ENST00000380152.8` (transcript), `ENSP00000369497.3` (protein). The version suffix is optional in most endpoints; omitting it resolves to current.
- Read-only. Ensembl REST is GET/POST for data retrieval only — no mutations.
- Sequences can be large: the BRCA2 genomic sequence is 85,183 bp. The `ensembl_get_sequence` tool returns the full sequence but always states the character count so callers can budget context usage.
- Species names are lowercase underscore-separated scientific names: `homo_sapiens`, `mus_musculus`, `drosophila_melanogaster`. These are opaque to non-biologists — `ensembl_list_species` is the discovery step.
- Overlap/region queries return all features in range — a 85 kb gene locus returns 44,000+ variants. The `feature` parameter selects which feature types to include; default is `gene` only to avoid overwhelming returns.
- `xrefs/symbol` returns only the gene's own Ensembl IDs. `xrefs/id` (by stable ID) returns the full cross-reference set across 10+ external databases (56 xrefs for BRCA2). Use `xrefs/id` not `xrefs/symbol`.
- POST batch endpoints available: `/lookup/id` accepts `{"ids": [...]}` (up to 50), `/lookup/symbol/{species}` accepts `{"symbols": [...]}` (up to 100), `/sequence/id` accepts `{"ids": [...]}` for batch sequence fetch. Batch significantly reduces N+1 round trips.
- Error envelope: `{"error": "ID 'X' not found"}` — a plain JSON object with a single `error` string field. HTTP status is 400 for bad input and 404-equivalent (also 400 or 500 depending on endpoint) for missing IDs. The API is not strictly RESTful with status codes.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ensembl-service` | Ensembl REST API (`rest.ensembl.org`) | All tools and resources |

Single service, single source. The service exposes typed methods per endpoint family, handles rate-limit headers, retries 429 and 5xx, and normalizes the error envelope (`{"error": "..."}`) into throwable `McpError`s.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `ENSEMBL_BASE_URL` | No | Override the Ensembl REST base URL. Default: `https://rest.ensembl.org`. Useful for pointing at Ensembl mirrors or GRCh37 legacy endpoint (`https://grch37.rest.ensembl.org`). |

No API key. The framework's standard env vars (`MCP_LOG_LEVEL`, `MCP_HTTP_PORT`, `MCP_AUTH_MODE`, etc.) apply.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with `ENSEMBL_BASE_URL` override
2. **Service** — `src/services/ensembl/ensembl-service.ts`: HTTP client, rate-limit-aware retry, error normalization, typed methods for each endpoint family
3. **Types** — `src/services/ensembl/types.ts`: response shapes confirmed against live API probes
4. **Core lookup tools** — `ensembl_lookup_gene` (symbol + ID + batch), `ensembl_list_species` (with local name filter)
5. **Sequence tool** — `ensembl_get_sequence` (all four types, region mode)
6. **Region + variant tools** — `ensembl_query_region`, `ensembl_predict_variant`
7. **Homology + xrefs tools** — `ensembl_get_homology`, `ensembl_get_xrefs`
8. **Resources** — gene and transcript entity resources, species list resource
9. **Prompt** — `ensembl_gene_dossier` workflow prompt
10. **Tests** — handler tests with mock context for each tool, including sparse-payload and batch cases

Each step is independently testable.

---

## Domain Mapping

| Noun | Operations | API Endpoints |
|:-----|:-----------|:--------------|
| Gene | lookup by symbol, lookup by ID, batch lookup | `GET /lookup/symbol/{species}/{symbol}`, `GET /lookup/id/{id}`, `POST /lookup/id`, `POST /lookup/symbol/{species}` |
| Transcript | lookup by ID, lookup via gene expand | `GET /lookup/id/{id}?expand=1` (via gene), `GET /lookup/id/{transcript_id}` |
| Sequence | by stable ID (gene/transcript/protein), by region | `GET /sequence/id/{id}?type=`, `GET /sequence/region/{species}/{region}`, `POST /sequence/id` |
| Feature overlap | genes, transcripts, variants, regulatory, exons in region | `GET /overlap/region/{species}/{region}?feature=` |
| Variant | VEP consequence prediction | `GET /vep/{species}/hgvs/{notation}`, `GET /vep/{species}/region/{chr}:{start}:{end}:{strand}/{allele}` |
| Homology | orthologs and paralogs | `GET /homology/symbol/{species}/{symbol}`, `GET /homology/id/{id}` |
| Cross-ref | external database IDs | `GET /xrefs/id/{id}`, `GET /xrefs/symbol/{species}/{symbol}` (limited — prefer `/xrefs/id`) |
| Species | list supported species | `GET /info/species?division=` |

---

## Workflow Analysis

**`ensembl_lookup_gene` — batch path (1–2 upstream calls):**

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `POST /lookup/symbol/{species}` or `POST /lookup/id` with `expand:1` | Batch resolve symbols/IDs → gene records, with transcripts when `expand_transcripts: true`. The batch POST supports `expand:1` directly — no second call needed. |
| — | — | Single-item path: `GET /lookup/symbol/{species}/{symbol}?expand=1` or `GET /lookup/id/{id}?expand=1` |

**`ensembl_gene_dossier` prompt (7 tool calls):**

This is a Prompt, not a tool — it guides the agent through:
1. `ensembl_lookup_gene` (symbol → ID + location)
2. `ensembl_get_sequence` (protein sequence of canonical transcript)
3. `ensembl_query_region` (variants in the gene's locus)
4. `ensembl_predict_variant` (consequence of any high-impact variants found)
5. `ensembl_get_homology` (mouse/rat orthologs)
6. `ensembl_get_xrefs` (UniProt + HGNC + EntrezGene IDs)
7. External chain: `pubmed` search using gene name, `pubchem` lookup using UniProt ID

---

## Design Decisions

**`ensembl_lookup_gene` as the single entry point, not split by lookup mode.** Symbol lookup and ID lookup serve the same goal (get a gene record) and produce identical output. Splitting into `ensembl_lookup_by_symbol` / `ensembl_lookup_by_id` would mean an agent has to know which format it has before calling. One tool, both paths, with the input schema distinguishing via `symbol`+`species` vs. `id` (Zod union with explicit discriminant).

**`ensembl_get_xrefs` uses `xrefs/id` not `xrefs/symbol`.** Live probing showed `xrefs/symbol` returns only 2 records (the gene's own Ensembl ID and its LRG). `xrefs/id` returns the full 56-record cross-reference set. The tool accepts the Ensembl stable ID, which the caller always has after `ensembl_lookup_gene`.

**`overlap/region` defaults to `feature=gene` only.** The BRCA2 locus returns 44,000+ items when all features are requested (genes + variations in a 85 kb region). Defaulting to gene only prevents context blowouts; callers explicitly opt into variation/regulatory data.

**No `ensembl_get_variation` tool.** The variation endpoint (`/variation/{species}/{id}`) fetches details for a known variant ID. This is well-covered by `ensembl_query_region` (finding variants in a region) and `ensembl_predict_variant` (the more useful "consequence" query). A dedicated variation-by-ID lookup would mostly serve chaining workflows where the ID came from a region query — handled by the region tool's output already including consequence terms.

**Species parameter defaults and guidance.** Most tools that require `species` default to `homo_sapiens` but call that out explicitly in the `.describe()` text, since the input format (`homo_sapiens`) is not obvious and `ensembl_list_species` is the discovery tool. The species parameter accepts the Ensembl internal name format only (not common names like "human" or "mouse").

**Rate limit: actual limit is 55,000/hr, not ~15/sec.** The REST API docs advertise "15 req/sec" but live headers show `x-ratelimit-limit: 55000` per `x-ratelimit-period: 3600`. Both constraints matter: the per-second burst guidance suggests the server queues fast batch sequences with a small inter-request delay, while the hourly bucket governs sustained workflows. The service layer tracks `x-ratelimit-remaining` and respects `Retry-After` on 429.

**GRCh37 legacy support via `ENSEMBL_BASE_URL`.** The main API uses GRCh38. Some clinical workflows still reference GRCh37 positions. Rather than baking assembly-switching logic into every tool, the `ENSEMBL_BASE_URL` env var allows pointing the entire server at `https://grch37.rest.ensembl.org` — a clean single-config answer for teams on the older build.

---

## Known Limitations

- **No BLAST / sequence similarity search.** Ensembl REST doesn't expose BLAST; that would require a different server (EMBL-EBI APIs).
- **Regulation and splice variants are partial.** The `regulatory` feature type in region queries returns basic regulatory elements but not full regulatory build annotation. Detailed splice isoform work is better done through Ensembl's bulk FTP downloads.
- **Non-vertebrate species coverage varies.** EnsemblGenomes (plants, fungi, metazoa, protists) is accessed via separate API endpoints (`https://rest.ensembl.org` handles some; others require `https://plants.rest.ensembl.org`). The `ENSEMBL_BASE_URL` override handles this for non-vertebrate teams.
- **VEP batch POST not supported in v0.1.0.** The REST API also exposes `POST /vep/{species}/hgvs` and `POST /vep/{species}/region` for bulk annotation of many variants in one call. The GET endpoints (`/vep/{species}/hgvs/{notation}` and `/vep/{species}/region/{region}/{allele}`) cover single-variant use; batch VEP is deferred.
- **Sequences are returned in full.** The API has no server-side pagination for sequences. A 85 kb genomic sequence is 85,183 characters — callers must manage context budget. The tool states the character count in its response to enable budget decisions.

---

## API Reference

**Base URL:** `https://rest.ensembl.org`  
**Required header:** `Accept: application/json`  
**Rate limit:** 55,000 req/hr per IP; `x-ratelimit-remaining` decrements on each call  
**Error envelope:** `{"error": "message string"}` — HTTP status is not reliably 404 vs 400  
**Versioned IDs:** `ENSG00000139618.7` — version suffix optional, omit for current  
**Species format:** Lowercase scientific name with underscores: `homo_sapiens`, `mus_musculus`  
**Region format:** `chr:start-end` — chromosome name as Ensembl uses it (no "chr" prefix for vertebrates: `13:32315086-32400268`)  
**HGVS format:** Transcript-relative: `ENST00000380152.8:c.2T>A`; genomic: `13:g.32316462T>A`  
**Assembly:** GRCh38 default for human; echoed in every coordinate-bearing response  

**Batch POST endpoints:**
- `POST /lookup/id` — body `{"ids": [...], "expand": 0|1}` — up to 50 IDs; returns map keyed by ID
- `POST /lookup/symbol/{species}` — body `{"symbols": [...]}` — returns map keyed by symbol
- `POST /sequence/id` — body `{"ids": [...], "type": "..."}` — batch sequence fetch

**Key endpoint families:**

| Family | GET pattern | Purpose |
|:-------|:------------|:--------|
| Lookup | `/lookup/symbol/{species}/{symbol}` | Gene/transcript metadata |
| Sequence | `/sequence/id/{id}?type=genomic\|cdna\|cds\|protein` | Raw sequence |
| Overlap | `/overlap/region/{species}/{chr}:{start}-{end}?feature=gene` | Features in region |
| VEP | `/vep/{species}/hgvs/{notation}` | Variant consequences |
| Homology | `/homology/symbol/{species}/{symbol}?type=orthologues` | Cross-species homologs |
| Xrefs | `/xrefs/id/{ensembl_id}?dbname=HGNC` | External DB cross-references |
| Species | `/info/species?division=EnsemblVertebrates` | Supported species catalog |
