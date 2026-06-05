/**
 * @fileoverview Tests for the ensembl://species resource.
 * @module tests/resources/species.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblSpeciesResource } from '@/mcp-server/resources/definitions/species.resource.js';
import type { SpeciesInfo } from '@/services/ensembl/types.js';

const mockListSpecies = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ listSpecies: mockListSpecies }),
}));

const mockSpecies: SpeciesInfo[] = Array.from({ length: 60 }, (_, i) => ({
  name: `species_${String(i + 1).padStart(2, '0')}`,
  displayName: `Species ${i + 1}`,
  taxonId: String(10000 + i),
  assembly: `Assembly${i + 1}`,
  division: 'EnsemblVertebrates',
}));

describe('ensemblSpeciesResource', () => {
  it('returns paginated species list (50 per page)', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const params = ensemblSpeciesResource.params.parse({});
    const result = (await ensemblSpeciesResource.handler(params, ctx)) as {
      species: SpeciesInfo[];
      nextCursor: string | undefined;
      totalCount: number;
    };
    expect(result.species).toHaveLength(50);
    expect(result.totalCount).toBe(60);
    expect(result.nextCursor).toBeDefined();
  });

  it('returns second page when cursor is provided', async () => {
    // Page 1
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx1 = createMockContext();
    const page1Result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params.parse({}),
      ctx1,
    )) as { species: SpeciesInfo[]; nextCursor: string | undefined; totalCount: number };
    const cursor = page1Result.nextCursor;
    expect(cursor).toBeDefined();

    // Page 2
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx2 = createMockContext();
    const page2Result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params.parse({ cursor }),
      ctx2,
    )) as { species: SpeciesInfo[]; nextCursor: string | undefined; totalCount: number };
    expect(page2Result.species).toHaveLength(10);
    expect(page2Result.nextCursor).toBeUndefined();
  });

  it('sorts species alphabetically by name', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params.parse({}),
      ctx,
    )) as { species: SpeciesInfo[]; nextCursor?: string; totalCount: number };
    for (let i = 1; i < result.species.length; i++) {
      expect(
        result.species[i]!.name.localeCompare(result.species[i - 1]!.name),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('lists example species resource', async () => {
    const listing = await ensemblSpeciesResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]!.uri).toBe('ensembl://species');
    expect(listing.resources[0]!.name).toContain('Species');
  });

  it('handles sparse species records without crash', async () => {
    mockListSpecies.mockResolvedValueOnce([{ name: 'minimal_organism' }]);
    const ctx = createMockContext();
    const result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params.parse({}),
      ctx,
    )) as { species: SpeciesInfo[]; totalCount: number };
    expect(result.species).toHaveLength(1);
    expect(result.species[0]!.name).toBe('minimal_organism');
  });
});
