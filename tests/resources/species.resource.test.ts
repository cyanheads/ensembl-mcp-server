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
  it('returns full species list with totalCount', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const params = ensemblSpeciesResource.params.parse({});
    const result = (await ensemblSpeciesResource.handler(params, ctx)) as {
      species: SpeciesInfo[];
      totalCount: number;
    };
    expect(result.species).toHaveLength(60);
    expect(result.totalCount).toBe(60);
  });

  it('passes division filter to service when specified', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const params = ensemblSpeciesResource.params.parse({ division: 'EnsemblPlants' });
    await ensemblSpeciesResource.handler(params, ctx);
    expect(mockListSpecies).toHaveBeenCalledWith('EnsemblPlants', expect.anything());
  });

  it('sorts species alphabetically by name', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params.parse({}),
      ctx,
    )) as { species: SpeciesInfo[]; totalCount: number };
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
