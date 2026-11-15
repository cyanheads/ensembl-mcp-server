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
      'Ensembl REST API base URL. Override to point at the GRCh37 legacy endpoint (https://grch37.rest.ensembl.org) or a local mirror.',
    ),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Clamp a count input above its per-call cap to the cap, with a notice. Set false to advertise the cap as the schema maximum and reject larger values instead.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Parses the server's env vars and replaces the cached config. `setup()` calls it
 * once the framework has loaded `.env`: `tool()` emits each input schema at import,
 * and the `max_results` maximum getter reads this config, so the first read can
 * predate `.env`. Throws `ConfigurationError` naming the variable on a bad value.
 */
export function loadServerConfig(): ServerConfig {
  _config = parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'ENSEMBL_BASE_URL',
    clampLimits: 'ENSEMBL_CLAMP_LIMITS',
  });
  return _config;
}

/** The loaded server config, parsed from the environment on first read. */
export function getServerConfig(): ServerConfig {
  return _config ?? loadServerConfig();
}
