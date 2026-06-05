/**
 * @fileoverview Server-specific configuration for ensembl-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://rest.ensembl.org')
    .describe(
      'Ensembl REST API base URL. Override to point at GRCh37 legacy endpoint ' +
        '(https://grch37.rest.ensembl.org) or a local mirror.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'ENSEMBL_BASE_URL',
  });
  return _config;
}

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
