/**
 * @fileoverview Tests for the server entry point: setup() reloads the server config before
 * the service reads it.
 * @module tests/index.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '@/config/server-config.js';
import { ensemblQueryRegion } from '@/mcp-server/tools/definitions/query-region.tool.js';
import { getEnsemblService } from '@/services/ensembl/ensembl-service.js';

type AppOptions = { setup?: (core: { config: AppConfig; storage: unknown }) => void };

const app = vi.hoisted(() => ({ options: undefined as AppOptions | undefined }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core')>();
  return {
    ...actual,
    createApp: async (options: AppOptions) => {
      app.options = options;
    },
  };
});

/** The `max_results` property of the input schema tools/list advertises. */
function advertisedMaxResults(): Record<string, unknown> {
  const schema = ensemblQueryRegion.input['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  }) as { properties: Record<string, unknown> };
  return JSON.parse(JSON.stringify(schema.properties.max_results)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  loadServerConfig();
});

describe('server entry point setup()', () => {
  it('reloads the config, so values set in .env after import reach the schema and the service', async () => {
    vi.stubEnv('ENSEMBL_CLAMP_LIMITS', undefined);
    vi.stubEnv('ENSEMBL_BASE_URL', undefined);
    // tool() emits the schema at import, before the framework has loaded .env.
    expect(advertisedMaxResults()).not.toHaveProperty('maximum');
    // The framework loads .env when createApp() starts, then calls setup().
    vi.stubEnv('ENSEMBL_CLAMP_LIMITS', 'false');
    vi.stubEnv('ENSEMBL_BASE_URL', 'https://grch37.rest.ensembl.org');
    await import('@/index.js');
    expect(app.options?.setup).toBeTypeOf('function');
    app.options?.setup?.({ config: {} as AppConfig, storage: createInMemoryStorage() });

    expect(advertisedMaxResults()).toMatchObject({ maximum: 5000 });
    const http = createFetchMock([
      {
        match: () => true,
        respond: Response.json({ id: 'ENST00000335295', object_type: 'Transcript' }),
      },
    ]);
    http.install();
    try {
      await getEnsemblService().lookupTranscript('ENST00000335295', createMockContext());
    } finally {
      http.restore();
    }
    expect(http.calls.map((call) => call.request.url)).toEqual([
      'https://grch37.rest.ensembl.org/lookup/id/ENST00000335295',
    ]);
  });
});
