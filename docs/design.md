# ensembl-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ensembl_list_species` | List species supported by Ensembl with display name, common name, assembly, taxon ID, and division. Required discovery step — species names like `homo_sapiens` are opaque to non-biologists and are the input format every other tool expects. Sorted by internal name and paged: `totalCount` reports every match, and when more follow, `truncated` plus a `nextOffset` to continue. | `division` (optional enum: `EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, `EnsemblProtists`), `nameContains` (local filter), `offset` (default 0), `max_results` (default 50, `0` uncapped) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_lookup_gene` | Resolve a gene by symbol + species or stable ID to its Ensembl ID, location, biotype, description, and transcripts. Synonyms and former symbols resolve with `matchedAlias`; several matches return `ambiguous` candidates. Batches process the first 20 distinct trimmed queries into ordered `succeeded`/`failed` items with query attribution; `batch.omitted` names the unattempted remainder to resubmit. Errors: `not_found`, `invalid_species` (find names with `ensembl_list_species` and `nameContains`), `no_input`, `conflicting_input`. | exactly one of `symbol`, `id`, `ids`, or `symbols` (at most 1,000 submitted batch items), `species` (optional, defaults to `homo_sapiens`; used by `symbol` and `symbols`), `expand_transcripts` (bool) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_get_sequence` | Fetch the DNA, cDNA, CDS, or protein sequence for a gene, transcript, protein, or genomic region. Returns a bounded window of the sequence (first 10,000 characters by default) with its stable ID, molecule type, full length, and — when more follows — `truncated` plus a `nextOffset` to continue. `type` controls which sequence is fetched: `genomic` (default, includes introns), `cdna` (spliced transcript), `cds` (coding sequence only), `protein`; region ids are genomic-only. Regions follow `[species:]chr:start(-\|..)end[:strand]` with strand `1` or `-1` (`:-1` returns the reverse complement). Errors: `not_found` (ID not in Ensembl), `type_mismatch` (a non-genomic type on a gene ID or a region, a non-protein type on a protein ID, or protein/cds on a non-coding transcript — use a transcript/protein stable ID instead), `invalid_species` (species not recognized — find it with `ensembl_list_species` and `nameContains`), `missing_species` (bare region without `species`), `invalid_region` (an id with a colon that fails the region grammar, reversed coordinates, the mitochondrion named `M`/`chrM` where Ensembl resolves that to another region or none, a start past the sequence region's end, a span over 10,000,000 bases, or an unknown sequence region). | `id` (stable ID, `species:chr:start-end`, or bare `chr:start-end` with `species`), `type` (enum: genomic, cdna, cds, protein), `species` (required for a bare region; a species prefix in `id` takes precedence), `expand_5prime` / `expand_3prime` (optional bp flanks), `offset` (default 0), `max_length` (default 10000, `0` uncapped) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_query_region` | Find genomic features overlapping a chromosomal region: genes, transcripts, variants, regulatory elements, or exons. Returns each feature with its stable ID, type, location, biotype, and name, plus the assembly the coordinates are on. Useful for "what's in this locus?" and for seeding follow-up lookups. Region format: `chr:start-end` with `species` set (e.g., `13:32315086-32400268`) or `species:chr:start-end` (e.g., `homo_sapiens:13:32315086-32400268`), at most 5,000,000 bases. Errors: `invalid_region` (reversed coordinates before any request; the mitochondrion named `M`/`chrM` where Ensembl resolves that to another region or none, before the overlap request; a malformed, out-of-bounds, or oversized region from Ensembl's rejection), `invalid_species`, `missing_species` (bare region without `species`). | `species` (required for a bare region; a species prefix in `region` takes precedence), `region` (`[species:]chr:start-end`), `feature` (enum array, at least one: gene, transcript, variation, regulatory, exon; default: gene), `biotype` (optional filter), `max_results` (default 100, `0` uncapped) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_predict_variant` | Predict the functional consequences of a sequence variant using the Ensembl Variant Effect Predictor (VEP). Accepts HGVS notation (transcript-relative, e.g., `ENST00000380152.8:c.2T>A`) or genomic HGVS, region+allele format (`chr:start:end:strand/allele`, e.g., `1:65568:65568:1/T`), or a dbSNP rsID (e.g., `rs334`). Returns the most severe consequence term, affected transcripts and genes, impact level (HIGH/MODERATE/LOW/MODIFIER), and any colocated known variants with clinical significance. Transcript consequences and per-variant PubMed IDs are capped by default, with truthful totals. Errors: `invalid_notation` (unparseable HGVS or region string, or a region+allele whose allele matches the reference or is not a base or SO term — check format), `not_found` (variant location outside any known transcript, or a sequence region the assembly lacks), `invalid_species` (species string not recognized — find it with `ensembl_list_species` and `nameContains`). | `variant` (HGVS notation, `chr:start:end:strand/allele`, or a dbSNP rsID), `species` (default: `homo_sapiens`), `max_transcript_consequences` / `max_pubmed_ids_per_variant` (default 10 each, `0` uncapped), `include_all_colocated_pubmed` | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_get_homology` | Find orthologs and paralogs with stable gene IDs, species, relationship type, identity metrics, and taxonomy level. Optional `targetProteinId` chains to `ensembl_get_sequence` with `type:"protein"`; optional `targetSymbol` is a bounded best-effort lookup. Missing enrichment never removes primary rows. Errors: `not_found`, `invalid_species` (`species` or `target_species`; find names with `ensembl_list_species` and `nameContains`), `no_input`, `conflicting_input`. | `symbol` or `id` (one required; an `ENS…` version suffix is dropped), `species` (default: `homo_sapiens`), `target_species` (optional), `type` (orthologues, paralogues, all; default: orthologues), `max_results` (default 25; 0 uncapped) | `readOnlyHint`, `openWorldHint: true` |
| `ensembl_get_xrefs` | Retrieve external references at the requested object's level by default. `all_levels:true` includes a gene's transcript and translation references independently of the database filter. `Reactome_gene` identifies gene pathways; `Reactome` translation pathways. Returns database name, primary ID, display ID and description; empty results remain successful. | `id` (Ensembl gene/transcript/translation stable ID), `dbname` (optional filter, e.g., `HGNC`, `RefSeq_mRNA`, `Reactome_gene`, `Reactome`, `GO`), `all_levels` (default false) | `readOnlyHint`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ensembl://gene/{id}` | Gene record by stable ID (`ENSG…`). Returns location, biotype, description, and transcript list. Stable, injectable context for multi-step workflows. | None needed — single entity |
| `ensembl://transcript/{id}` | Transcript record by stable ID (`ENST…`). Returns parent gene, location, biotype, canonical flag, and length. | None needed — single entity |
| `ensembl://species` | Ensembl species for the endpoint default division (vertebrates) with name, display name, assembly, taxon ID, and division. Addressable reference for tool bootstrapping. | First 50 by internal name, with `totalCount`, `shown`, `truncated`; a truncated body's notice routes to `ensembl_list_species` (`offset`, `max_results`) — the division holds ~356 vertebrate species |
| `ensembl://species/{division}` | Supported species in a single Ensembl division (`EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, `EnsemblProtists`). Division-addressable counterpart to `ensembl://species` (the endpoint default division). | First 50 by internal name, with `totalCount`, `shown`, `truncated`; a truncated body's notice routes to `ensembl_list_species` (`division`, `offset`, `max_results`) |

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
- Stable IDs carry a version: `ENSG00000139618.19` (gene), `ENST00000380152.8` (transcript), `ENSP00000369497.3` (protein). The stable-ID endpoints take only the unversioned form: `GET /lookup/id`, `/sequence/id`, and `/xrefs/id` answer a versioned ID — even the current version — with HTTP 400 `ID '…' not found`, `POST /lookup/id` answers it `null` (keying every answer by the ID as sent), and `/homology/id` answers HTTP 200 `{"data":[]}`. Lowercase IDs are accepted (`ensg00000139618`). IDs from other sources can carry a dotted suffix that is part of the ID (`AT3G52430.1`, an Arabidopsis transcript), and HGVS notation keeps its transcript version (`ENST00000380152.8:c.2T>A`).
- Read-only. Ensembl REST is GET/POST for data retrieval only — no mutations.
- Sequences can be large: the BRCA2 genomic sequence is 85,183 bp, TTN's 304,814 bp. `/sequence/region` serves genomic DNA only — it ignores a `type` parameter and returns `"molecule":"dna"` whatever is asked. It serves at most 10,000,000 bases per region (twice the overlap endpoint's limit), clipping the end to the sequence length first, and answers HTTP 400 for a reversed, out-of-bounds, or oversized region.
- Both region endpoints take `start-end` or `start..end`, an optional `:strand` suffix, and a `chr`-prefixed chromosome (`chr1:1000000-1000020` resolves to chromosome `1`). On `/sequence/region`, `:-1` returns the reverse complement (`1:1000000-1000020:-1` → `TCCGTGGCGGCGCGCTCCACC`) and `expand_5prime` then extends the higher coordinate; `:0` is served as the forward strand though undocumented, and `:+1` is rejected as undecodable. `M` and `chrM` resolve per species and per spelling (probed across 19 species): Drosophila resolves `M`, `m`, `chrM`, `ChrM`, and `CHRM` to its mitochondrion (`mitochondrion_genome`), and the honeybee `M`/`chrM` to its mitochondrion (`CM009947.2`); human resolves `M`, `m`, `chrM`, and `chrm` to an unrelated patch or haplotype scaffold that changes between calls (`HG2515_PATCH`, `HSCHR4_2_CTG8_1`) but `ChrM`/`CHRM` to `MT`, mouse likewise (unplaced scaffolds such as `JH584297.1` for `M`/`chrM`, `MT` for `CHRM`), C. elegans `M`/`chrM` to an unrelated contig, and P. falciparum `chrM` to chromosome 1. Zebrafish, chicken, rat, cattle, pig, dog, Ciona, A. gambiae, Arabidopsis, rice, maize, S. cerevisiae, and S. pombe answer "No slice found". `/info/assembly/{species}/{name}?synonyms=1` resolves a name the same way and lists the synonyms of the region it lands on: every correct resolution carries a mitochondrion name among them (`chrM`, `mitochondrion_genome`, `MT`), every wrong one none (`MU273394.1`, `MSCHRUN_CTG7`, `M01F1`, `MAL1`). In human, `MT`, `mt`, and `chrMT` resolve to the mitochondrion. Mitochondrion names differ by genome: `MT` in vertebrates, `mitochondrion_genome` in Drosophila, `MtDNA` in C. elegans, `Mt` in Arabidopsis, `Mito` in S. cerevisiae — `MT` is "No slice found" for the non-vertebrates.
- `/sequence/id` answers a protein ID with its protein for every `type` (`"molecule":"protein"`, HTTP 200), so the requested type alone does not say what came back; a non-coding transcript asked for `protein` or `cds` answers HTTP 400 `No sequences returned, please check the type specified is compatible with the object requested`.
- Species names are lowercase underscore-separated scientific names: `homo_sapiens`, `mus_musculus`, `drosophila_melanogaster`. These are opaque to non-biologists — `ensembl_list_species` is the discovery step.
- Overlap/region queries return all features in range with no paging — a 85 kb gene locus returns 44,000+ variants (~14 MB serialized). The `feature` parameter selects which feature types to include; default is `gene` only. The endpoint rejects a region longer than 5,000,000 bases, measured after clipping the end to the sequence length (so `MT:1-5000001` is served).
- Overlap rows carry a per-feature `assembly_name` (plain form, e.g. `GRCh38`) on every type except `regulatory`. `/info/assembly/:species` reports the same plain form as `default_coord_system_version`; its own `assembly_name` is the patch-level id (`GRCh38.p14`).
- `xrefs/symbol` maps an external name — synonym, former symbol, accession — to the Ensembl objects carrying it, matched case-insensitively. It resolves names `lookup/symbol` rejects with `No valid lookup found for symbol …` (maize `TB1` → `Zm00001eb054440`, `HER2` → `ENSG00000141736`). Without `object_type=gene` an accession also returns transcripts and translations (UniProt `P04637` lists TP53's transcripts). Gene results can include an `LRG_*` record mirroring the gene (`HER2` → `LRG_724`), a patch or haplotype copy whose `seq_region_name` is absent from `/info/assembly/{species}` `top_level_region` (`GPR172A` → `ENSG00000185803` on chr 8 and `ENSG00000285112` on `HG2419_PATCH`), or unrelated genes sharing the name (`MDR1` → `ABCB1` and `TBC1D9`). An unrecognized species answers HTTP 400 `Can not find internal name for species '…'`. `xrefs/id` lists external references at the requested object's level, with `all_levels=1` including child objects; use it for cross-references.
- POST batch endpoints available: `/lookup/id` accepts `{"ids": [...]}` and `/lookup/symbol/{species}` accepts `{"symbols": [...]}` (up to 1,000 each), `/sequence/id` accepts `{"ids": [...]}` for batch sequence fetch. Batch significantly reduces N+1 round trips.
- Error envelope: `{"error": "ID 'X' not found"}` — a plain JSON object with a single `error` string field. Ensembl answers every exception it catches with this envelope on HTTP 400, input errors and backend outages alike (`Could not connect to database …`, `DBI connect(…) failed`), so the status cannot tell the two apart; the message has to. Uncaught failures arrive as HTML 500/503 pages instead.
- Latency varies widely and can run to minutes. Measured on 2026-10-13 against rest.ensembl.org: an all-species BRCA2 orthologue set took 35–159 s, a mouse-only BRCA2 orthologue set 9–167 s, a 5 Mb gene+transcript+exon overlap 63–65 s, a 20-ID batch lookup 12–40 s, VEP calls 1–36 s, xrefs 0.6–19 s, and a 10 Mb sequence 14–18 s.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ensembl-service` | Ensembl REST API (`rest.ensembl.org`) | All tools and resources |

Single service, single source. The service exposes typed methods per endpoint family, handles rate-limit headers, retries 429, 5xx, timeouts, and database outages, and normalizes the error envelope (`{"error": "..."}`) into throwable `McpError`s. Every tool call is bounded: 180 s per upstream attempt (headers and body together) and 240 s for the whole call, every request it makes with its retries and backoff included.

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
| Gene | lookup by symbol, lookup by ID, batch lookup, alias resolution | `GET /lookup/symbol/{species}/{symbol}`, `GET /lookup/id/{id}`, `POST /lookup/id`, `POST /lookup/symbol/{species}`; aliases via `GET /xrefs/symbol/{species}/{symbol}?object_type=gene` and `GET /info/assembly/{species}` |
| Transcript | lookup by ID, lookup via gene expand | `GET /lookup/id/{id}?expand=1&mane=1` (via gene), `GET /lookup/id/{transcript_id}` |
| Sequence | by stable ID (gene/transcript/protein), by region | `GET /sequence/id/{id}?type=`, `GET /sequence/region/{species}/{region}`, `POST /sequence/id` |
| Feature overlap | genes, transcripts, variants, regulatory, exons in region | `GET /overlap/region/{species}/{region}?feature=` |
| Variant | VEP consequence prediction | `GET /vep/{species}/hgvs/{notation}`, `GET /vep/{species}/region/{chr}:{start}:{end}:{strand}/{allele}` |
| Homology | orthologs and paralogs | `GET /homology/symbol/{species}/{symbol}`, `GET /homology/id/{species}/{id}` |
| Cross-ref | external database IDs | `GET /xrefs/id/{id}` (`/xrefs/symbol` serves only the gene alias fallback) |
| Species | list supported species | `GET /info/species?division=` |

---

## Workflow Analysis

**`ensembl_lookup_gene` — single symbol (1 upstream call, up to 4 on an alias):**

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /lookup/symbol/{species}/{symbol}` (`?expand=1&mane=1` for transcripts) | Current gene names. Only `No valid lookup found for symbol …` continues; an unknown species is `invalid_species` here, with no xref request. |
| 2 | `GET /xrefs/symbol/{species}/{symbol}?object_type=gene` | Synonyms and former symbols → gene IDs, `LRG_*` dropped. None left: `not_found`. |
| 3 | `POST /lookup/id` (`?expand=1&mane=1` for transcripts) | Every candidate in one call. |
| 4 | `GET /info/assembly/{species}`, once per species per process | Only when two or more candidates remain: drop those off `top_level_region` (patch and haplotype copies) unless that drops them all; a failed read skips this step and keeps every candidate. One left → `gene` + `matchedAlias`; several → `ambiguous`. |

Measured: `BRCA2` 1 call, `NO_SUCH_GENE_ABC` 2, `TB1` (zea_mays) and `HER2` 3, `GPR172A` and `MDR1` 4 (3 once the species' regions are cached). `ensembl_lookup_gene` by `id` is one `GET /lookup/id/{id}`.

**`ensembl_lookup_gene` — batch path:** `ids` is one `POST /lookup/id`. `symbols` is one `POST /lookup/symbol/{species}`, then the single-symbol steps 2–4 for the misses: one xref call per miss (at most 4 in flight), one `POST /lookup/id` for every candidate when any exist, and at most one assembly call — 1 call for a fully resolved batch, at most 23 for 20 symbols. The batch POST answers an unknown species with the same `{}` as an all-miss batch, so when no symbol resolved directly, the first miss's xref call runs alone as the species check (`invalid_species` after 2 calls); a batch with a hit sends no check. A call Ensembl leaves unanswered through its retries (an HTML 503, a timeout) fails only the symbols that needed it, as `failed` items with reason `unavailable`, and the direct and alias hits still return; any other upstream error still fails the call. An unanswered species check proves nothing about the species, so the other misses still run; an unknown species fails them as `invalid_species`, and a transport failure never reports one. The single-symbol path has no other result to keep, so it still fails with Ensembl's `ServiceUnavailable`.

**`ensembl_gene_dossier` prompt (7 tool calls):**

This is a Prompt, not a tool — it guides the agent through:
1. `ensembl_lookup_gene` (symbol → ID + location)
2. `ensembl_get_sequence` (protein sequence from lookup's `canonicalTranscript`)
3. `ensembl_query_region` (variants in the gene's locus)
4. `ensembl_predict_variant` (consequence of any high-impact variants found)
5. `ensembl_get_homology` (mouse/rat orthologs)
6. `ensembl_get_xrefs` (UniProt + HGNC + EntrezGene IDs)
7. External chain: `pubmed` search using gene name, `pubchem` lookup using UniProt ID

---

## Design Decisions

**Transcript identity is preserved without selecting a transcript for the caller.** Lookup returns optional `canonicalTranscript` (including its version) and, only for transcript objects, `parentGeneId`. Expanded single, batch and alias lookups send `expand=1&mane=1` in the URL query; POST body flags alone do not return MANE. Transcript summaries map only `MANE_Select` entries to `maneSelect` via `refseq_match`, keeping Plus Clinical separate and absence unknown.

**VEP annotations retain allele attribution.** Every ID, HGVS and region request sends `hgvs=1&canonical=1&mane=1`. Flat SIFT/PolyPhen prediction-score pairs become typed objects, including zero scores; optional `canonical` and `maneSelect` stay absent when unreported. Records retain `alleleString`, and consequences retain `variantAllele`. Colocated `clin_sig` is aggregate for the known record, never a diagnosis of the submitted allele. Complete `clin_sig_allele` allele:term pairs become `clinicalSignificanceByAllele`, preserving all terms, with `clin_sig_ref_allele` separately exposed as `clinicalSignificanceReferenceAllele`; malformed segments contribute nothing. These fields ride existing requests and post-fetch caps without reordering consequences or changing totals.

**`ensembl_lookup_gene` as the single entry point, not split by lookup mode.** Symbol lookup and ID lookup serve the same goal (get a gene record) and produce identical output. Splitting into `ensembl_lookup_by_symbol` / `ensembl_lookup_by_id` would mean an agent has to know which format it has before calling. One tool, both paths, with optional `symbol`, `id`, `ids`, and `symbols` fields on a flat input object; the handler requires exactly one and throws `no_input` or `conflicting_input` otherwise.

**`ensembl_get_xrefs` uses `xrefs/id` with explicit object scope.** `xrefs/symbol` maps a name to the Ensembl objects carrying it, rather than listing external references. `xrefs/id` defaults to references on the requested object; `all_levels:true` includes its child objects, so a gene can reach transcript and translation references such as `RefSeq_mRNA`. The default stays false to preserve existing calls, with `dbname` independently filtering either scope. Empty-result guidance suggests changing scope or using the specific feature ID without asserting why references are absent.

**Read batches bound work separately from submitted input.** Up to 1,000 submitted IDs or symbols are trimmed and deduplicated in first-occurrence order. The first 20 distinct queries resolve through the existing lookup and alias paths; the remainder becomes ordered `batch.omitted` without requests. `succeeded`, `failed`, and `omitted` are disjoint partitions of submitted distinct queries, so an unattempted query never appears to have failed.

**Homology enrichment preserves the primary answer.** Upstream `target.protein_id` becomes optional `targetProteinId`. Only returned rows' distinct target gene IDs are looked up for `targetSymbol` through `POST /lookup/id`, in chunks of at most 1,000. Every chunk shares one five-second secondary budget, no retries, further limited by the original call's remaining 240-second deadline. Completed names survive partial lookup failure; missing names, outages and deadline expiry retain every homolog and truthful totals with composed guidance. Caller cancellation propagates. The primary homology request, ordering and `max_results:0` uncapped behavior remain unchanged.

**An empty filtered region does not identify its cause.** A supplied `biotype` may exclude features or the requested locus may contain none. Guidance names the filter, explains case sensitivity (`protein_coding`, `lncRNA`) and suggests removing it, without inferring an intergenic locus or making another overlap request. Assembly-resolution guidance composes with this notice.

**Aliases resolve inside `ensembl_lookup_gene`, and several matches are reported, never picked.** A synonym or former symbol is the common reason a symbol lookup misses, so the fallback runs in the tool that exists to resolve symbols rather than in a separate xref-search tool. Taking the first candidate would silently pick one of `MDR1`'s two unrelated genes, so a name that maps to several genes on reference regions returns them as `ambiguous` for the caller to retry by `id`.

**`overlap/region` defaults to `feature=gene` only.** The BRCA2 locus returns 44,000+ items when all features are requested (genes + variations in a 85 kb region). Defaulting to gene only prevents context blowouts; callers explicitly opt into variation/regulatory data. On top of that, `max_results` (default 100) caps the returned list post-fetch while `totalCount` stays the true count — the same shape as `ensembl_get_homology` — because an explicit `variation` request over one gene still returns tens of thousands of rows.

**Region length is enforced upstream, not pre-checked locally.** Ensembl clips the region end to the sequence length before applying its 5,000,000-base limit, so a local check on the requested span would reject regions the endpoint serves (`MT:1-5000001`, `1:248000000-253000001`). The tool classifies the endpoint's length rejection as `invalid_region` instead.

**`assemblyName` comes from the overlap rows first.** Every row type except `regulatory` carries it, so the common path costs no extra request; an empty or regulatory-only result falls back to the species default from `/info/assembly`, cached per species for the process. A failed fallback omits the field with a notice rather than guessing.

**Sequences come back in windows sliced after the fetch.** `ensembl_get_sequence` returns at most `max_length` characters (default 10,000) from `offset`, with `length` kept as the full length and `nextOffset` as the resume point. The slice runs on the resolved sequence rather than through Ensembl's `start`/`end` trim, because that trim hides the full length and cannot be combined with `expand_5prime`/`expand_3prime`; the cost is refetching the whole sequence per window.

**Region mode rejects non-genomic types up front.** `/sequence/region` ignores `type` and always answers with genomic DNA, so forwarding a `cdna`/`cds`/`protein` request would return the wrong molecule labelled as asked. The tool fails it as `type_mismatch` before any request.

**Region coordinates: order checked locally, bounds and length upstream.** Both region tools reject a reversed region (`1:500-100`, `1:500..100`, `1:500-100:-1`) as `invalid_region` before any request, since Ensembl answers every reversed form, `MT:16500-100` on the circular mitochondrion included, with a rejection. The 10,000,000-base (`/sequence/region`) and 5,000,000-base (`/overlap/region`) limits and the chromosome bounds are left to Ensembl, which clips the end to the sequence length before applying its limit (`MT:1-20000001` is served); its rejections are classified as `invalid_region`.

**One region grammar, shared by both region tools.** `[species:]chr:start(-|..)end[:strand]`, with species `[a-z0-9_]+`, chromosome `[\w.]+`, digit-string coordinates, and strand `1` or `-1` (the values Ensembl documents). A three-segment id is either `species:chr:range` or `chr:range:strand`, so the parse decides which, never a colon count; a species pattern without digits sent strain genomes such as `mus_musculus_129s1svimj` to stable-ID mode. `ensembl_get_sequence` treats any id with a colon as a region, since stable IDs never contain one, and rejects one the grammar does not take. `ensembl_query_region` reads a species prefix as the species (it wins over `species`, as on `ensembl_get_sequence`), runs the order check on every parsed region, and forwards the region without its prefix — Ensembl's overlap endpoint takes the species only in its path and reads a prefixed region's trailing `-end` as a strand. Forms the grammar does not take (`1:1,000,000-1,001,000`, a start-only `MT:16000`) are forwarded unchanged, and Ensembl serves or rejects them itself. Coordinates compare as digit strings, exact past double precision and linear in the input.

**A species prefix in a region wins over the `species` field, on both region tools.** The prefix names the organism the coordinates belong to; letting the field win returned another organism's sequence for the same coordinates with no error. On `ensembl_query_region` the prefix also makes `species` optional, so a region copied from `ensembl_get_sequence` works as written; a bare region without `species` fails as `missing_species` before any request.

**`M` and `chrM` are forwarded only where Ensembl resolves them to the mitochondrion.** In human, mouse, C. elegans, and P. falciparum both endpoints resolve them to an unrelated sequence region rather than rejecting them, so forwarding returns the wrong sequence or features as a success; Drosophila and the honeybee resolve them correctly, so rejecting everywhere would fail calls that answered right. No species-level rule separates the two (mitochondrion names, patches, and divisions all cut across them), so both region tools ask Ensembl: before the request, `M`/`chrM` in any case goes to `/info/assembly/{species}/{name}?synonyms=1`, and the call is forwarded only when the region it lands on lists a mitochondrion name among its synonyms. Otherwise it fails as `invalid_region` naming the species' mitochondrion (`MT:1-20`), read from its reference regions when one is recognizably named, with generic guidance when none is (P. falciparum's `Pf3D7_MIT_v3`); a "No slice found" answer fails the same way. The spelling is passed as written, since Ensembl's answer depends on it (human `CHRM` is `MT`, `chrM` a patch). Cost: one small request per species and spelling, kept for the process lifetime — the wrong resolutions vary between calls but never land on the mitochondrion — plus, on a rejection, the reference-region list `ensembl_lookup_gene` already caches; no other input pays anything. The check runs after the missing-species and reversed-coordinate checks, which need no request. It reads the chromosome segment, so it also covers forms `ensembl_query_region` otherwise forwards unparsed (`chrM:16000`); `MT`, `mt`, and `chrMT` pass without it.

**Versions are dropped from Ensembl stable IDs in the service, at every stable-ID request.** Ensembl's stable-ID endpoints answer a versioned ID as not found (homology as an empty list), while IDs copied from GENCODE or from Ensembl's own `canonical_transcript` field (`ENST00000380152.8`) carry one. `EnsemblService` strips a trailing `.N` from an `ENS…` ID with an 11-digit number in each method that sends a caller's stable ID (`lookupGeneById`, `lookupGenesBatch`, `lookupTranscript`, `getSequenceById`, `getXrefsById`, `getHomologyById`), so every tool and resource is covered and a new caller cannot miss it. The tools echo the ID as submitted (`ensembl_get_xrefs` `queriedId`, error messages, a batch item's `query`), and the records carry Ensembl's unversioned ID. A batch sends each stable ID once; inputs that differ only by version stay separate items with the same record, so every submitted ID maps to an answer. A stale version resolves to the current record — the endpoints offer no versioned lookup. `ensembl_get_sequence` decides region mode by the colon first, so a dotted chromosome is never stripped, and non-`ENS` IDs (`AT3G52430.1`) and HGVS input pass unchanged.

**The returned molecule, not the ID prefix, decides a protein-ID mismatch.** `/sequence/id` returns the protein for a protein ID whatever `type` asks, so `ensembl_get_sequence` fails a `protein` molecule for a `genomic`, `cdna`, or `cds` request as `type_mismatch` after the request. Protein ID prefixes vary by species (`ENSP` for human, `ENSMUSP` for mouse), so a prefix check would need a per-species table.

**No `ensembl_get_variation` tool.** The variation endpoint (`/variation/{species}/{id}`) fetches details for a known variant ID. This is well-covered by `ensembl_query_region` (finding variants in a region) and `ensembl_predict_variant` (the more useful "consequence" query). A dedicated variation-by-ID lookup would mostly serve chaining workflows where the ID came from a region query — handled by the region tool's output already including consequence terms.

**Species lists are paged after the filter and sort; the resources stay unpaged URIs.** An unfiltered division runs 236–1,499 species (Fungi is ~250 KB), so `ensembl_list_species` returns `max_results` (default 50) from `offset` after `nameContains` and the internal-name sort — `/info/species` order varies per call, so sorting first is what makes pages repeatable. The species resources return the same first 50 with `totalCount`/`shown`/`truncated` and route the rest to the tool: a `{?offset}` expansion in the URI template is mandatory in the SDK's `UriTemplate`, so it would stop matching the bare `ensembl://species/{division}`.

**Species parameter defaults and guidance.** Most tools that require `species` default to `homo_sapiens` but call that out explicitly in the `.describe()` text, since the input format (`homo_sapiens`) is not obvious and `ensembl_list_species` is the discovery tool. The descriptions teach the Ensembl internal name format, which every endpoint accepts; Ensembl also resolves some common-name aliases itself (`human` on `/lookup/symbol` and `/vep`), but the tools neither document nor rely on them. Every unknown-species hint routes through `nameContains` (a genus or common name) and, for non-vertebrates, `division`: a bare "call `ensembl_list_species`" lands on a 50-species first page that need not hold the species.

**Rate limit: actual limit is 55,000/hr, not ~15/sec.** The REST API docs advertise "15 req/sec" but live headers show `x-ratelimit-limit: 55000` per `x-ratelimit-period: 3600`. Both constraints matter: the per-second burst guidance argues for pacing rapid sequential calls, while the hourly bucket governs sustained workflows. The service layer honors `Retry-After` on 429.

**Error envelopes are classified by message first, status second.** Because Ensembl puts input errors and outages on the same HTTP 400, the service reads the message: a database-connection failure, or any message carrying the source location Perl appends to an uncaught `die` (`… at /path/Module.pm line 121.`, a crash inside Ensembl's own code), becomes a retryable `ServiceUnavailable` with a generic message (Ensembl's text names its database host or server paths, so it stays in the log); the not-found and invalid patterns keep their codes; anything else maps by status — 404 to `NotFound`, 5xx to `ServiceUnavailable`, the rest to `ValidationError` with Ensembl's message unchanged. Tools map service errors to declared reasons by message text, so every service-authored message (outage, timeout, deadline) is worded to match no tool's pattern.

**Every tool call is bounded twice.** Each upstream attempt aborts after 180 s, covering the body read as well as the headers, and surfaces as a retryable `Timeout`; the whole tool call — every request it makes, with their attempts and backoff — stops at 240 s with `retry_deadline_exceeded`. One budget spans the call because a symbol batch resolving aliases makes up to nine rounds of requests in sequence, which per-request deadlines would let run past half an hour. The attempt bound sits above the slowest success measured (167 s, see Requirements), so a slow-but-answering Ensembl is not cut off at the latencies measured; the deadline leaves room for one retry after a full-length attempt. A transport failure (refused connection, DNS) is a retryable `ServiceUnavailable` whose message omits the host. A caller's cancellation still ends the call at once and is never retried or reported as a timeout. The service keeps raw `fetch` rather than the framework's `fetchWithTimeout`, which throws on every non-2xx before the envelope can be read.

**GRCh37 legacy support via `ENSEMBL_BASE_URL`.** The main API uses GRCh38. Some clinical workflows still reference GRCh37 positions. Rather than baking assembly-switching logic into every tool, the `ENSEMBL_BASE_URL` env var allows pointing the entire server at `https://grch37.rest.ensembl.org` — a clean single-config answer for teams on the older build.

---

## Known Limitations

- **No BLAST / sequence similarity search.** Ensembl REST doesn't expose BLAST; that would require a different server (EMBL-EBI APIs).
- **Regulation and splice variants are partial.** The `regulatory` feature type in region queries returns basic regulatory elements but not full regulatory build annotation. Detailed splice isoform work is better done through Ensembl's bulk FTP downloads.
- **Non-vertebrate species coverage varies.** EnsemblGenomes (plants, fungi, metazoa, protists) is accessed via separate API endpoints (`https://rest.ensembl.org` handles some; others require `https://plants.rest.ensembl.org`). The `ENSEMBL_BASE_URL` override handles this for non-vertebrate teams.
- **VEP batch POST not supported in v0.1.0.** The REST API also exposes `POST /vep/{species}/hgvs` and `POST /vep/{species}/region` for bulk annotation of many variants in one call. The GET endpoints (`/vep/{species}/hgvs/{notation}` and `/vep/{species}/region/{region}/{allele}`) cover single-variant use; batch VEP is deferred.
- **Sequence windows refetch the whole sequence.** The API has no pagination for sequences, so each window is sliced from a full fetch: walking all of TTN's 304,814 bp at the default window is 31 requests for the same payload. Set `max_length` to `0` (or a larger window) when the whole sequence is wanted.

---

## API Reference

**Base URL:** `https://rest.ensembl.org`  
**Required header:** `Accept: application/json`  
**Rate limit:** 55,000 req/hr per IP; `x-ratelimit-remaining` decrements on each call  
**Error envelope:** `{"error": "message string"}` — usually on HTTP 400 whatever the cause, backend outages included  
**Versioned IDs:** `ENSG00000139618.19` — the stable-ID endpoints accept only the unversioned form (`ENSG00000139618`), which resolves to the current version  
**Species format:** Lowercase scientific name with underscores: `homo_sapiens`, `mus_musculus`  
**Region format:** `chr:start-end` (or `chr:start..end`), optional `:1`/`:-1` strand — chromosome name as Ensembl uses it (`13:32315086-32400268`, mitochondrion `MT` in vertebrates); a `chr` prefix is also accepted (`chr13`), but Ensembl's own output omits it  
**HGVS format:** Transcript-relative: `ENST00000380152.8:c.2T>A`; genomic: `13:g.32316462T>A`  
**Assembly:** GRCh38 default for human; echoed in every coordinate-bearing response  

**Batch POST endpoints:**
- `POST /lookup/id` — body `{"ids": [...], "expand": 0|1}` — up to 1,000 IDs; returns map keyed by ID
- `POST /lookup/symbol/{species}` — body `{"symbols": [...]}` — up to 1,000 symbols; returns map keyed by symbol
- `POST /sequence/id` — body `{"ids": [...], "type": "..."}` — batch sequence fetch

**Key endpoint families:**

| Family | GET pattern | Purpose |
|:-------|:------------|:--------|
| Lookup | `/lookup/symbol/{species}/{symbol}` | Gene/transcript metadata |
| Sequence | `/sequence/id/{id}?type=genomic\|cdna\|cds\|protein` | Raw sequence |
| Overlap | `/overlap/region/{species}/{chr}:{start}-{end}?feature=gene` | Features in region |
| VEP | `/vep/{species}/hgvs/{notation}` | Variant consequences |
| Homology | `/homology/symbol/{species}/{symbol}?type=orthologues` | Cross-species homologs |
| Xrefs | `/xrefs/id/{ensembl_id}?external_db=HGNC&all_levels=1` | External references with explicit child-object scope |
| Species | `/info/species?division=EnsemblVertebrates` | Supported species catalog |
