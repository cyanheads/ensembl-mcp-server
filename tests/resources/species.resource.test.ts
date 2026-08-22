/**
 * @fileoverview Tests for the ensembl://species and ensembl://species/{division} resources.
 * @module tests/resources/species.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  ensemblSpeciesByDivisionResource,
  ensemblSpeciesResource,
} from '@/mcp-server/resources/definitions/species.resource.js';
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

type SpeciesResult = { species: SpeciesInfo[]; totalCount: number };

describe('ensemblSpeciesResource (static, default division)', () => {
  it('returns full species list with totalCount', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const params = ensemblSpeciesResource.params!.parse({});
    const result = (await ensemblSpeciesResource.handler(params, ctx)) as SpeciesResult;
    expect(result.species).toHaveLength(60);
    expect(result.totalCount).toBe(60);
  });

  it('fetches the default division (no division filter passed to the service)', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    await ensemblSpeciesResource.handler(ensemblSpeciesResource.params!.parse({}), ctx);
    expect(mockListSpecies).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('sorts species alphabetically by name', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params!.parse({}),
      ctx,
    )) as SpeciesResult;
    for (let i = 1; i < result.species.length; i++) {
      expect(
        result.species[i]!.name.localeCompare(result.species[i - 1]!.name),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('lists the all-species resource', async () => {
    const listing = await ensemblSpeciesResource.list!(
      {} as Parameters<NonNullable<typeof ensemblSpeciesResource.list>>[0],
    );
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]!.uri).toBe('ensembl://species');
    expect(listing.resources[0]!.name).toContain('Species');
  });

  it('handles sparse species records without crash', async () => {
    mockListSpecies.mockResolvedValueOnce([{ name: 'minimal_organism' }]);
    const ctx = createMockContext();
    const result = (await ensemblSpeciesResource.handler(
      ensemblSpeciesResource.params!.parse({}),
      ctx,
    )) as SpeciesResult;
    expect(result.species).toHaveLength(1);
    expect(result.species[0]!.name).toBe('minimal_organism');
  });
});

describe('ensemblSpeciesByDivisionResource (templated by division)', () => {
  it('passes the addressed division through to the service', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies]);
    const ctx = createMockContext();
    const params = ensemblSpeciesByDivisionResource.params!.parse({ division: 'EnsemblPlants' });
    const result = (await ensemblSpeciesByDivisionResource.handler(params, ctx)) as SpeciesResult;
    expect(mockListSpecies).toHaveBeenCalledWith('EnsemblPlants', expect.anything());
    expect(result.totalCount).toBe(60);
  });

  it('rejects an invalid division value', () => {
    expect(() =>
      ensemblSpeciesByDivisionResource.params!.parse({ division: 'EnsemblAliens' }),
    ).toThrow();
  });

  it('lists one addressable URI per division', async () => {
    const listing = await ensemblSpeciesByDivisionResource.list!(
      {} as Parameters<NonNullable<typeof ensemblSpeciesByDivisionResource.list>>[0],
    );
    expect(listing.resources).toHaveLength(5);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri as string).toMatch(/^ensembl:\/\/species\/Ensembl/);
    }
    expect(listing.resources.map((r) => r.uri)).toContain('ensembl://species/EnsemblPlants');
  });
});
