/**
 * @fileoverview Tests for the ensembl_list_species tool.
 * @module tests/tools/list-species.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ensemblListSpecies } from '@/mcp-server/tools/definitions/list-species.tool.js';
import type { SpeciesInfo } from '@/services/ensembl/types.js';

const mockListSpecies = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ listSpecies: mockListSpecies }),
}));

const defaultSpecies: SpeciesInfo[] = [
  {
    name: 'homo_sapiens',
    displayName: 'Homo sapiens',
    commonName: 'Human',
    taxonId: '9606',
    assembly: 'GRCh38',
    division: 'EnsemblVertebrates',
  },
  {
    name: 'mus_musculus',
    displayName: 'Mus musculus',
    commonName: 'Mouse',
    taxonId: '10090',
    assembly: 'GRCm39',
    division: 'EnsemblVertebrates',
  },
  {
    name: 'danio_rerio',
    displayName: 'Danio rerio',
    commonName: 'Zebrafish',
    taxonId: '7955',
    assembly: 'GRCz11',
    division: 'EnsemblVertebrates',
  },
];

describe('ensemblListSpecies', () => {
  it('returns all species sorted by name when no filters applied', async () => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const ctx = createMockContext();
    const input = ensemblListSpecies.input.parse({});
    const result = await ensemblListSpecies.handler(input, ctx);
    expect(result.species.length).toBe(3);
    expect(result.totalCount).toBe(3);
    // Sorted alphabetically
    expect(result.species[0]!.name).toBe('danio_rerio');
    expect(result.species[1]!.name).toBe('homo_sapiens');
    expect(result.species[2]!.name).toBe('mus_musculus');
  });

  it('filters by nameContains case-insensitively', async () => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const ctx = createMockContext();
    const input = ensemblListSpecies.input.parse({ nameContains: 'human' });
    const result = await ensemblListSpecies.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.species[0]!.name).toBe('homo_sapiens');
  });

  it('filters by nameContains matching internal name', async () => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const ctx = createMockContext();
    const input = ensemblListSpecies.input.parse({ nameContains: 'sapiens' });
    const result = await ensemblListSpecies.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.species[0]!.name).toBe('homo_sapiens');
  });

  it('returns empty list and total 0 when nameContains matches nothing', async () => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const ctx = createMockContext();
    const input = ensemblListSpecies.input.parse({ nameContains: 'xyz_no_match_123' });
    const result = await ensemblListSpecies.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.species).toHaveLength(0);
  });

  it('returns species with all optional fields when present', async () => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const ctx = createMockContext();
    const input = ensemblListSpecies.input.parse({ nameContains: 'homo' });
    const result = await ensemblListSpecies.handler(input, ctx);
    const human = result.species[0]!;
    expect(human.name).toBe('homo_sapiens');
    expect(human.displayName).toBe('Homo sapiens');
    expect(human.commonName).toBe('Human');
    expect(human.taxonId).toBe('9606');
    expect(human.assembly).toBe('GRCh38');
    expect(human.division).toBe('EnsemblVertebrates');
  });

  it('formats species list as structured text', () => {
    const output = {
      species: [
        {
          name: 'homo_sapiens',
          displayName: 'Homo sapiens',
          commonName: 'Human',
          taxonId: '9606',
          assembly: 'GRCh38',
          division: 'EnsemblVertebrates',
        },
      ],
      totalCount: 1,
    };
    const blocks = ensemblListSpecies.format!(output);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('homo_sapiens');
    expect(text).toContain('Homo sapiens');
    expect(text).toContain('GRCh38');
    expect(text).toContain('9606');
  });

  it('formats empty result as "No matching species found"', () => {
    const blocks = ensemblListSpecies.format!({ species: [], totalCount: 0 });
    const text = (blocks[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('No matching species found');
  });

  it('sparse species record (only name, no optional fields) renders without crash', async () => {
    mockListSpecies.mockResolvedValueOnce([{ name: 'sparse_organism' }]);
    const ctx = createMockContext();
    const input = ensemblListSpecies.input.parse({});
    const result = await ensemblListSpecies.handler(input, ctx);
    expect(result.species[0]!.name).toBe('sparse_organism');
    expect(result.species[0]!.displayName).toBeUndefined();
    // format should not crash on sparse item
    const blocks = ensemblListSpecies.format!(result);
    expect(blocks[0]!.type).toBe('text');
  });
});
