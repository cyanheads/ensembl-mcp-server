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

type SpeciesResult = {
  species: SpeciesInfo[];
  totalCount: number;
  shown: number;
  truncated: boolean;
  notice?: string;
};

const sortedNames = mockSpecies.map((s) => s.name);

describe('ensemblSpeciesResource (static, default division)', () => {
  it('returns the first 50 species by name with truthful totals (issue #3)', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies].reverse());
    const ctx = createMockContext();
    const params = ensemblSpeciesResource.params!.parse({});
    const result = (await ensemblSpeciesResource.handler(params, ctx)) as SpeciesResult;
    expect(result.species.map((s) => s.name)).toEqual(sortedNames.slice(0, 50));
    expect(result.totalCount).toBe(60);
    expect(result.shown).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('ensembl_list_species');
    expect(result.notice).toContain('offset 50');
    expect(result.notice).toContain('max_results');
    expect(result.notice).toContain('division omitted');
  });

  it.each([0, 50])(
    'returns a complete body, truncated: false and no notice, for %i species',
    async (count) => {
      mockListSpecies.mockResolvedValueOnce(mockSpecies.slice(0, count));
      const ctx = createMockContext();
      const result = (await ensemblSpeciesResource.handler(
        ensemblSpeciesResource.params!.parse({}),
        ctx,
      )) as SpeciesResult;
      expect(result.species).toHaveLength(count);
      expect(result.totalCount).toBe(count);
      expect(result.shown).toBe(count);
      expect(result.truncated).toBe(false);
      expect(result).not.toHaveProperty('notice');
    },
  );

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

  it('caps the division body at 50 and names the division in the continuation notice (issue #3)', async () => {
    mockListSpecies.mockResolvedValueOnce([...mockSpecies].reverse());
    const ctx = createMockContext();
    const params = ensemblSpeciesByDivisionResource.params!.parse({ division: 'EnsemblFungi' });
    const result = (await ensemblSpeciesByDivisionResource.handler(params, ctx)) as SpeciesResult;
    expect(result.species.map((s) => s.name)).toEqual(sortedNames.slice(0, 50));
    expect(result.totalCount).toBe(60);
    expect(result.shown).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('ensembl_list_species');
    expect(result.notice).toContain('division "EnsemblFungi"');
    expect(result.notice).toContain('offset 50');
    expect(result.notice).toContain('max_results');
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
