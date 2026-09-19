# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-09-19

mcp-ts-core 0.13.6 adoption: an unrecognized or misspelled argument key now succeeds instead of failing, argument rejections carry a reason and recovery hint under Invalid params, and every declared tool error closes with a (reason ...) suffix

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-08-22

MCP 2026-07-28 and SDK v2 adoption adds strict tool inputs, public cache hints, and an explicit stateless HTTP deployment

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-07-09

ensembl_predict_variant and ensembl_get_homology cap high-cardinality output (transcript consequences, PubMed IDs, homologs) by default with truthful totals and an uncap escape hatch; every declared ctx.fail site now surfaces a recovery hint

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-07-09

ensembl_get_sequence forwards expand_5prime/expand_3prime to stable-ID genomic lookups and accepts a bare chr:start-end region when species is set; mcp-ts-core 0.10.10 → 0.10.14 with a Bun supply-chain guard and Dockerfile hardening

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-07-03

ensembl_predict_variant accepts dbSNP rsIDs via a new VEP /id endpoint; ensembl_query_region exon rows carry parentId/rank; chromosome-name docs corrected; gene-dossier prompt's variant workflow now attributes impact to VEP

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-03 · 🛡️ Security

Adds a division-addressable ensembl://species/{division} resource; ensembl_get_homology symbol queries now return the resolved Ensembl stable gene ID as queryId; mcp-ts-core 0.10.10 clears 7 transitive vulnerabilities (bun audit 7 → 0)

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-21 · ⚠️ Breaking

Breaking: ensembl_get_sequence output field lengthInBp → length (unit-aware); ensembl_get_homology and ensembl_lookup_gene now reject more than one of symbol/id/ids/symbols; symbol descriptions corrected to state species defaults to homo_sapiens

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

mcp-ts-core ^0.10.6 → ^0.10.9; new check-dependency-specifiers devcheck gate; plugin-manifest packaging checks; fresh-scaffold/worktree devcheck guards; 14 skills re-synced; biome 2.5 + dep refresh

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-11

mcp-ts-core ^0.9.21 → ^0.10.6; name/title identity in createApp(); Dockerfile healthcheck + APP_VERSION label; bundle script runs clean-mcpb.ts

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

ensembl_query_region: invalid region strings raise the invalid_region contract; empty-result notice includes chr-prefix guidance

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint at ensembl.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 7 tools, 3 resources, 1 prompt over the Ensembl REST API; security hardening strips internal URL from error data
