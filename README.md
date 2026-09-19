<div align="center">
  <h1>@cyanheads/ensembl-mcp-server</h1>
  <p><b>Look up genes, fetch sequences, predict variant consequences, find orthologs, and retrieve cross-database xrefs from Ensembl REST via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ensembl-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ensembl-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ensembl-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `ensembl_lookup_gene` | Resolve a gene by symbol + species or by stable ID to its Ensembl ID, genomic location, biotype, and transcript list |
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

All resource data is also reachable via the `ensembl_list_species` tool, which additionally filters by name.

### Prompts

| Prompt | Description |
|:---|:---|
| `ensembl_gene_dossier` | Structured workflow for assembling a complete gene profile: symbol → ID + location → sequence → variants → orthologs → xrefs |

## Capability reference

### `ensembl_list_species` <sub>tool</sub>

- Filter by division (`EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, `EnsemblProtists`) or `nameContains` for a local substring match against name, display name, and common name
- Omit `division` to return the endpoint default division (vertebrates, ~356 species on the default GRCh38 endpoint)
- Returns internal name (the value every other tool expects), display name, common name, taxon ID, assembly, and division
- Required first step — species names like `homo_sapiens` are opaque to non-biologists

---

### `ensembl_lookup_gene` <sub>tool</sub>

- Exactly one of `symbol` (+ optional `species`, default `homo_sapiens`), `id`, `ids` (batch, up to 20), or `symbols` (batch, up to 20)
- `expand_transcripts` (default `false`) adds the full transcript list with biotype and canonical flag
- Batch modes (`ids`/`symbols`) return a `succeeded`/`failed` split with per-item error strings instead of failing the call
- Errors: `not_found`, `invalid_species`, `no_input`, `conflicting_input`

---

### `ensembl_get_sequence` <sub>tool</sub>

- `type`: `genomic` (default, includes introns), `cdna` (spliced), `cds` (coding only), `protein`
- Accepts a stable ID (`ENSG…`/`ENST…`/`ENSP…`) or a region — `species:chr:start-end`, or bare `chr:start-end` with `species` set
- `expand_5prime` / `expand_3prime` (default `0`) extend flanking base pairs for genomic and region queries
- `protein` and `cds` require a transcript or protein ID, not a gene ID
- Every response states `length` so callers can budget context before consuming large sequences
- Errors: `not_found`, `type_mismatch`, `missing_species`

---

### `ensembl_query_region` <sub>tool</sub>

- `region` in `chr:start-end` format; `feature` array defaults to `["gene"]`, also accepts `transcript`, `variation`, `regulatory`, `exon`; optional `biotype` filter
- Defaults to genes only — requesting `variation` on a large locus can return 44,000+ features
- Exon rows carry a `parentId` and `rank`, since one exon is reported once per parent transcript
- Errors: `invalid_region`, `invalid_species`

---

### `ensembl_predict_variant` <sub>tool</sub>

- `variant` accepts HGVS (transcript-relative or genomic), region+allele (`chr:start:end:strand/allele`), or a dbSNP rsID
- `max_transcript_consequences` (default `10`) and `max_pubmed_ids_per_variant` (default `10`) cap large VEP results; set either to `0` for the full set, or `include_all_colocated_pubmed: true` for uncapped PubMed IDs
- Returns most severe consequence term, per-transcript impact (HIGH/MODERATE/LOW/MODIFIER), and colocated known variants with clinical significance
- Totals (`transcriptConsequencesTotal`, `pubmedTotal`) are always reported even when capped
- Errors: `invalid_notation`, `not_found`

---

### `ensembl_get_homology` <sub>tool</sub>

- Exactly one of `symbol` (+ `species`, default `homo_sapiens`) or `id`; optional `target_species` filter
- `type`: `orthologues` (default), `paralogues`, or `all`
- `max_results` caps the homolog list (default `25`, `0` uncapped); `totalCount` always reports the true count available
- Errors: `not_found`, `no_input`, `conflicting_input`

---

### `ensembl_get_xrefs` <sub>tool</sub>

- `id` (`ENSG…`/`ENST…`) required; optional `dbname` filter (e.g. `HGNC`, `Uniprot_gn`, `EntrezGene`, `MIM_GENE`, `RefSeq_mRNA`, `Reactome`, `GO`)
- Uses the `xrefs/id` endpoint, returning the full cross-reference set (56+ entries for well-annotated genes like BRCA2)
- Errors: `not_found`

---

### `ensembl://gene/{id}` <sub>resource</sub>

- Returns location, biotype, description, and transcript list for a gene stable ID (`ENSG…`); version suffix optional
- Errors: `not_found`

---

### `ensembl://transcript/{id}` <sub>resource</sub>

- Returns parent gene, location, biotype, canonical flag, and length for a transcript stable ID (`ENST…`); version suffix optional
- Errors: `not_found`

---

### `ensembl://species` <sub>resource</sub>

- No parameters — returns the endpoint default division (vertebrates, ~356 species on the default GRCh38 endpoint)
- For a named division, read `ensembl://species/{division}` instead

---

### `ensembl://species/{division}` <sub>resource</sub>

- `division` required: `EnsemblVertebrates`, `EnsemblPlants`, `EnsemblFungi`, `EnsemblMetazoa`, or `EnsemblProtists`

---

### `ensembl_gene_dossier` <sub>prompt</sub>

- Arguments: `gene_symbol` required; `species` optional (default `homo_sapiens`)
- Sequences a 7-step workflow: resolve the gene → fetch the protein sequence → find variants in the locus → predict variant consequences → find cross-species orthologs → get external database IDs → synthesize the dossier

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Ensembl-specific:

- Keyless REST API — no API key required; Ensembl REST is fully public at 55,000 req/hr
- Rate-limit-aware service layer: tracks `x-ratelimit-remaining`, retries 429 with `Retry-After`, and retries transient 5xx
- Batch POST endpoints used throughout — `POST /lookup/id` (up to 50 IDs) and `POST /lookup/symbol/{species}` reduce N+1 round trips in multi-gene workflows
- GRCh37 legacy support via `ENSEMBL_BASE_URL` — point the entire server at `https://grch37.rest.ensembl.org` for clinical workflows on the older assembly
- All coordinate-bearing responses echo the assembly name so agents never see a bare genomic position without assembly context

Agent-friendly output:

- Sequence character count stated on every `ensembl_get_sequence` response so callers can budget context before consuming large genomic sequences
- `ensembl_list_species` is explicitly the discovery step — tool descriptions call out the opaque internal-name format and direct agents to it before using species-dependent tools
- Cross-tool chaining made explicit: xref IDs from `ensembl_get_xrefs` are described as inputs for protein and literature servers; the `ensembl_gene_dossier` prompt sequences all 6 tools into one research workflow

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
