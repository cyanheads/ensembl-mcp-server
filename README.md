<div align="center">
  <h1>@cyanheads/ensembl-mcp-server</h1>
  <p><b>Look up genes, fetch sequences, predict variant consequences, find orthologs, and retrieve cross-database xrefs from Ensembl REST via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ensembl-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ensembl-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ensembl-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ensembl-mcp-server/releases/latest/download/ensembl-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ensembl-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZW5zZW1ibC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ensembl-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fensembl-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://ensembl.caseyjhand.com/mcp](https://ensembl.caseyjhand.com/mcp)

</div>

---

## Overview

Gene, sequence, and variant data for vertebrates and other model organisms from the Ensembl REST API. Look up genes, fetch sequences, predict variant consequences, find orthologs, and cross-reference external databases from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `ensembl_list_species` | List species supported by Ensembl with display name, common name, assembly, taxon ID, and division |
| `ensembl_lookup_gene` | Resolve a gene by symbol (synonyms and former symbols included) + species or by stable ID to its Ensembl ID, genomic location, biotype, and transcript list |
| `ensembl_get_sequence` | Fetch the DNA, cDNA, CDS, or protein sequence for a gene, transcript, protein, or genomic region |
| `ensembl_query_region` | Find genomic features (genes, transcripts, variants, regulatory elements, exons) overlapping a chromosomal region |
| `ensembl_predict_variant` | Predict functional consequences of a sequence variant using the Ensembl Variant Effect Predictor (VEP) |
| `ensembl_get_homology` | Find orthologs and/or paralogs of a gene across species with percent identity and taxonomy level |
| `ensembl_get_xrefs` | Retrieve cross-database references for a gene — HGNC, UniProt, EntrezGene, OMIM, RefSeq, Reactome, and others |

### Resources

| Resource | Description |
|:---|:---|
| `ensembl://gene/{id}` | Gene record by stable ID (`ENSG…`) — location, biotype, description, and transcript list |
| `ensembl://transcript/{id}` | Transcript record by stable ID (`ENST…`) — parent gene, location, biotype, canonical flag, and length |
| `ensembl://species` | Supported Ensembl species for the endpoint default division (vertebrates on the default endpoint) |
| `ensembl://species/{division}` | Supported species in one division (`EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, `EnsemblProtists`) |

The species resources return the first 50 species by internal name; the `ensembl_list_species` tool pages through the rest and filters by name.

### Prompts

| Prompt | Description |
|:---|:---|
| `ensembl_gene_dossier` | Structured workflow for assembling a complete gene profile: symbol → ID + location → sequence → variants → orthologs → xrefs |

## Capability reference

Ensembl's stable-ID endpoints answer a versioned ID (`ENSG00000139618.19`) as not found, so every tool and resource that takes an Ensembl stable ID drops a trailing `.N` from an `ENS…` ID before the request and returns the current version. HGVS input to `ensembl_predict_variant` (`ENST00000380152.8:c.2T>A`) keeps its version, and IDs from other sources (`AT3G52430.1`) are forwarded unchanged.

### `ensembl_list_species` <sub>tool</sub>

- Optional `division` (`EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, `EnsemblProtists`; omitted, the endpoint default — vertebrates, ~356 species on GRCh38) and `nameContains`, a substring match against name, display name, and common name
- Returns the internal name every other tool expects (`homo_sapiens`), plus display name, common name, taxon ID, assembly, and division
- Sorted by internal name and paged by `offset` (default `0`) and `max_results` (default `50`, `0` uncapped); `totalCount` reports every match, and `nextOffset` is where the next page starts when more follow

---

### `ensembl_lookup_gene` <sub>tool</sub>

- Exactly one of `symbol` (+ `species`, default `homo_sapiens`), `id`, `ids`, or `symbols` (batches up to 20); `expand_transcripts` (default `false`) adds the transcript list with biotype and canonical flag
- A symbol that is not a current gene name falls back to synonyms and former symbols (`HER2` → `ERBB2`, maize `TB1` → `TCP1`), reported as `matchedAlias`; patch and haplotype copies are set aside, and a name still shared by several genes (`MDR1`) returns `ambiguous` with the candidates to retry by `id`
- A single lookup returns `gene` (or `ambiguous`); a batch returns `succeeded` items carrying the submitted `query` (an ID as written, version included; IDs that differ only by version are separate items with the same record) and `failed` items with `query`, `reason` (`not_found`, `ambiguous` with `candidates`, or `unavailable` when Ensembl did not answer the symbol's synonym lookup after retries), `error`, and `recovery`, instead of failing the call. A `symbols` batch on an unrecognized species throws `invalid_species`. Errors: `not_found`, `invalid_species`, `no_input`, `conflicting_input`

---

### `ensembl_get_sequence` <sub>tool</sub>

- A stable ID (`ENSG…`/`ENST…`/`ENSP…`) or a region (`species:chr:start-end`, or `chr:start-end` with `species`; at most 10,000,000 bases); `type` is `genomic` (default), `cdna`, `cds`, or `protein` — `cdna` and `cds` from a transcript ID only, `protein` from a transcript or protein ID; `expand_5prime`/`expand_3prime` add flanking bases
- Regions also take `start..end` and a `:1`/`:-1` strand suffix (`1:1000000-1000020:-1` returns the reverse complement); a species prefix in `id` wins over `species`, and the mitochondrion is `MT` in vertebrates (`mitochondrion_genome` in Drosophila, `MtDNA` in C. elegans)
- `M` and `chrM` (any case) are forwarded only where Ensembl resolves them to the mitochondrion — Drosophila `M`/`chrM`, human and mouse `CHRM` — and otherwise rejected as `invalid_region` naming the species' mitochondrion; human `chrM` would otherwise return an unrelated patch scaffold. One cached `/info/assembly` lookup per species and spelling decides it
- Returns a window set by `offset` (default `0`) and `max_length` (default `10000`, `0` uncapped); `length` is the full sequence length, and `truncated`/`nextOffset` say where to resume
- Errors: `not_found`, `type_mismatch` (also a protein ID asked for `genomic`/`cdna`/`cds`, or a non-coding transcript asked for `protein`/`cds`), `invalid_species`, `missing_species`, `invalid_region` (also an id with a colon that is not a valid region)

---

### `ensembl_query_region` <sub>tool</sub>

- `region` as `species:chr:start-end`, or `chr:start-end` with `species` (a species prefix wins over `species` and is not forwarded); at most 5,000,000 bases; reversed coordinates are rejected before any request, and `M`/`chrM` as `ensembl_get_sequence` treats them — use `MT` in vertebrates, `mitochondrion_genome` in Drosophila, `MtDNA` in C. elegans; `feature` defaults to `["gene"]` and also accepts `transcript`, `variation`, `regulatory`, `exon`; optional `biotype` filter
- `max_results` caps the list (default `100`, `0` uncapped) while `totalCount` reports the true count; `assemblyName` names the coordinates' assembly, and exon rows carry `parentId` and `rank`. Errors: `invalid_region`, `invalid_species`, `missing_species`

---

### `ensembl_predict_variant` <sub>tool</sub>

- `variant` as HGVS (transcript-relative or genomic), region+allele (`chr:start:end:strand/allele`), or a dbSNP rsID
- Returns the most severe consequence, per-transcript impact (HIGH/MODERATE/LOW/MODIFIER), and colocated known variants with clinical significance. Errors: `invalid_notation`, `not_found`, `invalid_species`
- `max_transcript_consequences` and `max_pubmed_ids_per_variant` (default `10` each, `0` uncapped; `include_all_colocated_pubmed` lifts the PubMed cap) bound the result, while `transcriptConsequencesTotal` and `pubmedTotal` report the full counts

---

### `ensembl_get_homology` <sub>tool</sub>

- Exactly one of `symbol` (+ `species`, default `homo_sapiens`) or `id`; `type` is `orthologues` (default), `paralogues`, or `all`; optional `target_species` filter
- `max_results` caps the list (default `25`, `0` uncapped) while `totalCount` reports the true count. Errors: `not_found`, `invalid_species` (unknown `species` or `target_species`), `no_input`, `conflicting_input`

---

### `ensembl_get_xrefs` <sub>tool</sub>

- `id` (`ENSG…`/`ENST…`) required; optional `dbname` filter (e.g. `HGNC`, `Uniprot_gn`, `EntrezGene`, `MIM_GENE`, `RefSeq_mRNA`, `Reactome`, `GO`)
- Returns the full cross-reference set (56+ entries for a well-annotated gene such as BRCA2). Errors: `not_found`

---

### `ensembl://gene/{id}` <sub>resource</sub>

- `id` is a gene stable ID (`ENSG…`); a version suffix is optional and dropped
- Returns location, biotype, description, and transcript list. Errors: `not_found`

---

### `ensembl://transcript/{id}` <sub>resource</sub>

- `id` is a transcript stable ID (`ENST…`); a version suffix is optional and dropped
- Returns parent gene, location, biotype, canonical flag, and length. Errors: `not_found`

---

### `ensembl://species` <sub>resource</sub>

- No parameters — covers the endpoint default division (vertebrates, ~356 species on the default GRCh38 endpoint)
- Returns the first 50 species by internal name with `totalCount`, `shown`, and `truncated`; a truncated body's `notice` points to `ensembl_list_species` (`offset`, `max_results`) for the rest
- For a named division, read `ensembl://species/{division}` instead

---

### `ensembl://species/{division}` <sub>resource</sub>

- `division` required: `EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, or `EnsemblProtists`
- Returns that division's first 50 species by internal name — internal name, display name, assembly, taxon ID, and division — with `totalCount`, `shown`, and `truncated`; a truncated body's `notice` points to `ensembl_list_species` (`division`, `offset`, `max_results`) for the rest

---

### `ensembl_gene_dossier` <sub>prompt</sub>

- Arguments: `gene_symbol` required; `species` optional (default `homo_sapiens`)
- Sequences a 7-step workflow: resolve the gene → fetch the protein sequence → find variants in the locus → predict variant consequences → find cross-species orthologs → get external database IDs → synthesize the dossier

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Ensembl-specific:

- Keyless REST API — no API key required; Ensembl REST is fully public at 55,000 req/hr
- Rate-limit-aware service layer: retries 429 honoring `Retry-After`, and retries transient 5xx, HTML error pages, and Ensembl database outages
- Bounded upstream calls: 180 s per attempt (headers and body) and 240 s per call, retries included, so a stalled Ensembl fails with a timeout instead of hanging
- Batch POST endpoints used throughout — `POST /lookup/id` and `POST /lookup/symbol/{species}` (up to 1,000 items each upstream) reduce N+1 round trips in multi-gene workflows
- GRCh37 legacy support via `ENSEMBL_BASE_URL` — point the entire server at `https://grch37.rest.ensembl.org` for clinical workflows on the older assembly
- All coordinate-bearing responses echo the assembly name so agents never see a bare genomic position without assembly context

Agent-friendly output:

- `ensembl_get_sequence` returns sequences in bounded windows (10,000 characters by default) with the full length and a `nextOffset` to continue, so a long gene or locus never lands in one response unasked
- `ensembl_list_species` is explicitly the discovery step — tool descriptions call out the opaque internal-name format and direct agents to it before using species-dependent tools; it returns 50 species per page by default with a `nextOffset` to continue, so even the ~1,500-species Fungi division stays bounded
- Cross-tool chaining made explicit: xref IDs from `ensembl_get_xrefs` are described as inputs for protein and literature servers; the `ensembl_gene_dossier` prompt sequences 6 of the 7 tools into one research workflow

## Getting started

### Public Hosted Instance

A public instance is available at `https://ensembl.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "ensembl-mcp-server": {
      "type": "streamable-http",
      "url": "https://ensembl.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "ensembl-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/ensembl-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "ensembl-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/ensembl-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "ensembl-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/ensembl-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — Ensembl REST is fully public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/ensembl-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd ensembl-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you need to override ENSEMBL_BASE_URL (e.g. for GRCh37)
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `ENSEMBL_BASE_URL` | Ensembl REST API base URL. Override for GRCh37 (`https://grch37.rest.ensembl.org`) or a local mirror. | `https://rest.ensembl.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. Schema default `auto` resolves to stateful; this server explicitly uses stateless. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t ensembl-mcp-server .
docker run --rm -p 3010:3010 ensembl-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/ensembl-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services |
| `src/config` | Server-specific environment variable parsing and validation with Zod |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — 7 tools |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — gene, transcript, species |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`) — gene dossier workflow |
| `src/services/ensembl` | Ensembl REST API client — HTTP, rate-limit handling, retry, error normalization |
| `tests/` | Unit and integration tests mirroring `src/` |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
