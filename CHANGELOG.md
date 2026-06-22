# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
