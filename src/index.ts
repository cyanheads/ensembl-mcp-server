#!/usr/bin/env node
/**
 * @fileoverview ensembl-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { ensemblGeneDossierPrompt } from './mcp-server/prompts/definitions/gene-dossier.prompt.js';
import { ensemblGeneResource } from './mcp-server/resources/definitions/gene.resource.js';
import { ensemblSpeciesResource } from './mcp-server/resources/definitions/species.resource.js';
import { ensemblTranscriptResource } from './mcp-server/resources/definitions/transcript.resource.js';
import { ensemblGetHomology } from './mcp-server/tools/definitions/get-homology.tool.js';
import { ensemblGetSequence } from './mcp-server/tools/definitions/get-sequence.tool.js';
import { ensemblGetXrefs } from './mcp-server/tools/definitions/get-xrefs.tool.js';
import { ensemblListSpecies } from './mcp-server/tools/definitions/list-species.tool.js';
import { ensemblLookupGene } from './mcp-server/tools/definitions/lookup-gene.tool.js';
import { ensemblPredictVariant } from './mcp-server/tools/definitions/predict-variant.tool.js';
import { ensemblQueryRegion } from './mcp-server/tools/definitions/query-region.tool.js';
import { initEnsemblService } from './services/ensembl/ensembl-service.js';

await createApp({
  name: 'ensembl-mcp-server',
  title: 'ensembl-mcp-server',
  tools: [
    ensemblListSpecies,
    ensemblLookupGene,
    ensemblGetSequence,
    ensemblQueryRegion,
    ensemblPredictVariant,
    ensemblGetHomology,
    ensemblGetXrefs,
  ],
  resources: [ensemblGeneResource, ensemblTranscriptResource, ensemblSpeciesResource],
  prompts: [ensemblGeneDossierPrompt],
  instructions: `Ensembl genomics server — vertebrate and model organism gene, sequence, and variant data.
Species names use Ensembl internal format: lowercase_underscore scientific names (homo_sapiens, mus_musculus).
Discovery workflow: ensembl_list_species → ensembl_lookup_gene → ensembl_get_sequence / ensembl_get_xrefs / ensembl_get_homology.
For a complete gene research workflow, use the ensembl_gene_dossier prompt.
Override the default GRCh38 endpoint by setting ENSEMBL_BASE_URL (e.g. https://grch37.rest.ensembl.org for GRCh37).`,
  setup(core) {
    initEnsemblService(core.config, core.storage);
  },
});
