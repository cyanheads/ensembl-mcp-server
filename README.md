<div align="center">
  <h1>@cyanheads/ensembl-mcp-server</h1>
  <p><b>Look up genes, fetch sequences, predict variant consequences, find orthologs and cross-database xrefs via Ensembl REST via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 3 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ensembl-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ensembl-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ensembl-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ensembl-mcp-server/releases/latest/download/ensembl-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ensembl-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZW5zZW1ibC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ensembl-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fensembl-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools covering the core Ensembl REST API surface — species discovery, gene/transcript lookup, sequence retrieval, genomic region overlap, variant consequence prediction, cross-species homology, and external database cross-references:

| Tool | Description |
|:-----|:------------|
| `ensembl_list_species` | List species supported by Ensembl with display name, common name, assembly, taxon ID, and division |
| `ensembl_lookup_gene` | Resolve a gene by symbol + species or by stable ID to its Ensembl ID, genomic location, biotype, and transcript list |
| `ensembl_get_sequence` | Fetch the DNA, cDNA, CDS, or protein sequence for a gene, transcript, protein, or genomic region |
| `ensembl_query_region` | Find genomic features (genes, transcripts, variants, regulatory elements, exons) overlapping a chromosomal region |
| `ensembl_predict_variant` | Predict functional consequences of a sequence variant using the Ensembl Variant Effect Predictor (VEP) |
| `ensembl_get_homology` | Find orthologs and/or paralogs of a gene across species with percent identity and taxonomy level |
| `ensembl_get_xrefs` | Retrieve cross-database references for a gene — HGNC, UniProt, EntrezGene, OMIM, RefSeq, Reactome, and others |

### `ensembl_list_species`

Discovery tool for the Ensembl species catalog.

- Filter by division: vertebrates, plants, fungi, metazoa, or protists
- Optional name filter (`nameContains`) for local substring matching
- Returns display name, common name, assembly, taxon ID, and Ensembl division for each species
- Required first step — species names like `homo_sapiens` are opaque to non-biologists and are the input format every other tool expects

---

### `ensembl_lookup_gene`

Single entry point for resolving gene identity.

- Symbol + species lookup (`BRCA2` + `homo_sapiens`) or direct stable ID lookup (`ENSG00000139618`)
- Batch lookup of up to 20 IDs or symbols in one call via POST endpoints
- Optional transcript expansion — returns full transcript list with biotype and canonical flag
- Returns Ensembl stable ID, genomic location (chr:start-end:strand), biotype, description, and transcript list
- Errors: `not_found` (symbol or ID not in Ensembl), `invalid_species` (call `ensembl_list_species` to discover valid names)

---

### `ensembl_get_sequence`

Fetch any sequence type for any Ensembl feature.

- Molecule types: `genomic` (default, includes introns), `cdna` (spliced), `cds` (coding only), `protein`
- Accepts stable IDs or `species:chr:start-end` region format for genomic region mode
- Optional flanking sequence (`expand_5prime`, `expand_3prime`) in base pairs
- Returns sequence with stable ID, molecule type, and character count — large sequences (e.g. BRCA2 at 85,183 bp genomic) returned in full with explicit length so callers can budget context usage

---

### `ensembl_query_region`

Find all genomic features overlapping a chromosomal window.

- Region format: `chr:start-end` (e.g. `13:32315086-32400268`) — no `chr` prefix for vertebrates
- Feature types: `gene` (default), `transcript`, `variation`, `regulatory`, `exon`
- Optional biotype filter
- Defaults to gene only to prevent context overload — a large locus can contain 44,000+ variants when all feature types are selected

---

### `ensembl_predict_variant`

Predict variant consequences via the Ensembl VEP.

- Accepts HGVS notation (transcript-relative: `ENST00000380152.8:c.2T>A`) or genomic region+allele format (`13:32316462:32316462:1/A`)
- Returns most severe consequence term, affected transcripts and genes, impact level (HIGH/MODERATE/LOW/MODIFIER)
- Includes colocated known variants with clinical significance (ClinVar, dbSNP)
- Errors: `invalid_notation` (check format), `not_found` (location outside any known transcript)

---

### `ensembl_get_homology`

Cross-species homolog lookup.

- Returns orthologs (default) or paralogs, or both
- Optional `target_species` filter to narrow to specific organisms
- Each homolog carries stable ID, species, relationship type (ortholog_one2one, ortholog_one2many, etc.), `perc_id`, `perc_pos`, and taxonomy level

---

### `ensembl_get_xrefs`

Full cross-database reference set for any Ensembl feature.

- Returns all external IDs by default: HGNC, UniProt, EntrezGene, OMIM, RefSeq, Reactome, and more (56 xrefs for BRCA2)
- Optional `dbname` filter (e.g. `HGNC`, `Uniprot_gn`, `EntrezGene`, `MIM_GENE`) to narrow output
- Uses the `xrefs/id` endpoint (not `xrefs/symbol`) — returns the full cross-reference set
- IDs returned here chain directly to protein, literature, disease, and pathway resources in other MCP servers

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `ensembl://gene/{id}` | Gene record by stable ID (`ENSG…`) — location, biotype, description, and transcript list |
| Resource | `ensembl://transcript/{id}` | Transcript record by stable ID (`ENST…`) — parent gene, location, biotype, canonical flag, and length |
| Resource | `ensembl://species` | Full list of supported Ensembl species with name, display name, assembly, taxon ID, and division |
| Prompt | `ensembl_gene_dossier` | Structured workflow for assembling a complete gene profile: symbol → ID + location → sequence → variants → orthologs → xrefs |

All resource data is also reachable via tools. The `ensembl://species` resource provides the full species catalog with cursor pagination; `ensembl_list_species` is the tool equivalent with filtering support.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Ensembl-specific:

- Keyless REST API — no API key required; Ensembl REST is fully public at 55,000 req/hr
- Rate-limit-aware service layer: tracks `x-ratelimit-remaining`, retries 429 with `Retry-After`, and retries transient 5xx
- Batch POST endpoints used throughout — `POST /lookup/id` (up to 50 IDs) and `POST /lookup/symbol/{species}` reduce N+1 round trips in multi-gene workflows
- GRCh37 legacy support via `ENSEMBL_BASE_URL` — point the entire server at `https://grch37.rest.ensembl.org` for clinical workflows on the older assembly
- All coordinate-bearing responses echo the assembly name so agents never see a bare genomic position without assembly context

Agent-friendly output:

- Sequence character count stated on every `ensembl_get_sequence` response so callers can budget context before consuming large genomic sequences
- `ensembl_list_species` is explicitly the discovery step — tool descriptions call out the opaque internal-name format and direct agents to it before using species-dependent tools
- Cross-tool chaining made explicit: xref IDs from `ensembl_get_xrefs` are described as inputs for protein and literature servers; the `ensembl_gene_dossier` prompt sequences the full 7-tool research workflow

## Getting started

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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
