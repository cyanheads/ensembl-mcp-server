/**
 * @fileoverview Tests for the ensembl_list_species tool.
 * @module tests/tools/list-species.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblListSpecies } from '@/mcp-server/tools/definitions/list-species.tool.js';
import type { SpeciesInfo } from '@/services/ensembl/types.js';

const mockListSpecies = vi.fn();

vi.mock('@/services/ensembl/ensembl-service.js', () => ({
  getEnsemblService: () => ({ listSpecies: mockListSpecies }),
}));

beforeEach(() => {
  mockListSpecies.mockReset();
  mockListSpecies.mockRejectedValue(new Error('unmocked listSpecies'));
});

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

describe('ensemblListSpecies zero-match surface', () => {
  it('reports a zero-match notice on both surfaces with no truncation fields', async () => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const result = await runToolContract(ensemblListSpecies, { nameContains: 'xyz_no_match_123' });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.totalCount).toBe(0);
    expect(sc.species).toEqual([]);
    expect(sc.notice).toContain('No species matched "xyz_no_match_123"');
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('nextOffset');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('No species matched "xyz_no_match_123"');
  });

  it.each<[{ division?: 'EnsemblPlants' }, string]>([
    // Unfiltered pages hold 50 species, so browsing without nameContains is no route to one.
    [{}, 'set division: without it only vertebrates are searched'],
    [{ division: 'EnsemblPlants' }, 'in EnsemblPlants. Try a shorter fragment'],
  ])('steers a zero match to a shorter fragment or a division (%o)', async (extra, expected) => {
    mockListSpecies.mockResolvedValueOnce([...defaultSpecies]);
    const result = await runToolContract(ensemblListSpecies, { nameContains: 'maize', ...extra });
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.notice).toContain(expected);
    expect(sc.notice).toContain('genus or common name');
    expect(sc.notice).not.toContain('without nameContains');
  });
});

/** `n` sparse species named `<prefix>_001`… — padded so name order equals index order. */
function makeSpecies(n: number, prefix = 'species'): SpeciesInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `${prefix}_${String(i + 1).padStart(3, '0')}`,
    displayName: `${prefix} ${i + 1}`,
    division: 'EnsemblFungi',
  }));
}

/** Deterministic reordering so a test proves the handler sorts before slicing. */
function scrambled<T>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, key: (i * 37) % items.length }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

type PageSc = {
  species: SpeciesInfo[];
  totalCount: number;
  nextOffset?: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
  notice?: string;
};

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

describe('ensemblListSpecies annotations', () => {
  it('declares openWorldHint: true — it reads live from rest.ensembl.org', () => {
    expect(ensemblListSpecies.annotations?.openWorldHint).toBe(true);
  });
});

describe('ensemblListSpecies cap and offset paging (issue #3)', () => {
  const sixty = makeSpecies(60);

  it('caps an unfiltered call at 50 by default and discloses the remainder on both surfaces', async () => {
    mockListSpecies.mockResolvedValueOnce(scrambled(sixty));
    const result = await runToolContract(ensemblListSpecies, {});
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as PageSc;
    expect(sc.species.map((s) => s.name)).toEqual(sixty.slice(0, 50).map((s) => s.name));
    expect(sc.totalCount).toBe(60);
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(50);
    expect(sc.cap).toBe(50);
    expect(sc.nextOffset).toBe(50);
    expect(sc.notice).toContain('nextOffset');
    expect(sc.notice).toContain('offset 50');
    const text = textOf(result);
    expect(text).toContain('50 of 60');
    expect(text).toContain('Next offset:** 50');
    expect(text).toContain('offset 50');
  });

  it('returns every matching species when max_results is 0', async () => {
    mockListSpecies.mockResolvedValueOnce(scrambled(sixty));
    const result = await runToolContract(ensemblListSpecies, { max_results: 0 });
    const sc = result.structuredContent as PageSc;
    expect(sc.species.map((s) => s.name)).toEqual(sixty.map((s) => s.name));
    expect(sc.totalCount).toBe(60);
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('nextOffset');
    expect(sc).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('(60 total)');
  });

  it('walks nextOffset to disjoint, name-ordered pages that rebuild the uncapped list', async () => {
    const pages: PageSc[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      // Upstream order varies per call — scramble differently each page.
      mockListSpecies.mockResolvedValueOnce(
        pages.length % 2 === 0 ? scrambled(sixty) : [...sixty].reverse(),
      );
      const result = await runToolContract(ensemblListSpecies, { offset, max_results: 25 });
      const sc = result.structuredContent as PageSc;
      pages.push(sc);
      offset = sc.nextOffset;
    }
    expect(pages.map((p) => p.species.length)).toEqual([25, 25, 10]);
    expect(pages.map((p) => p.nextOffset)).toEqual([25, 50, undefined]);
    expect(pages.map((p) => p.truncated)).toEqual([true, true, undefined]);
    for (const p of pages) expect(p.totalCount).toBe(60);
    const walked = pages.flatMap((p) => p.species.map((s) => s.name));
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual(sixty.map((s) => s.name));
    // The final page carries neither truncation nor a continuation notice.
    expect(pages[2]).not.toHaveProperty('notice');
  });

  it('treats a page ending exactly at totalCount as final', async () => {
    mockListSpecies.mockResolvedValueOnce([...sixty]);
    const result = await runToolContract(ensemblListSpecies, { offset: 10, max_results: 50 });
    const sc = result.structuredContent as PageSc;
    expect(sc.species).toHaveLength(50);
    expect(sc.species[0]!.name).toBe('species_011');
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('nextOffset');
  });

  it('returns everything from offset to the end when max_results is 0 and offset is set', async () => {
    mockListSpecies.mockResolvedValueOnce([...sixty]);
    const result = await runToolContract(ensemblListSpecies, { offset: 55, max_results: 0 });
    const sc = result.structuredContent as PageSc;
    expect(sc.species.map((s) => s.name)).toEqual(sixty.slice(55).map((s) => s.name));
    expect(sc).not.toHaveProperty('truncated');
  });

  it('reports an offset equal to totalCount as past the end, distinct from a zero match', async () => {
    mockListSpecies.mockResolvedValueOnce([...sixty]);
    const result = await runToolContract(ensemblListSpecies, { offset: 60 });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as PageSc;
    expect(sc.species).toEqual([]);
    expect(sc.totalCount).toBe(60);
    expect(sc).not.toHaveProperty('truncated');
    expect(sc).not.toHaveProperty('nextOffset');
    expect(sc.notice).toContain('offset 60 is at or past the end');
    expect(sc.notice).not.toContain('No species matched');
    const text = textOf(result);
    expect(text).toContain('60 species match');
    expect(text).not.toContain('No matching species found');
  });

  it('composes nameContains with the cap: totalCount is the filtered pre-cap count', async () => {
    const fungi = [
      ...makeSpecies(132, 'saccharomyces'),
      ...makeSpecies(40, 'aspergillus'),
      ...makeSpecies(30, 'candida'),
    ];
    mockListSpecies.mockResolvedValueOnce(scrambled(fungi));
    const result = await runToolContract(ensemblListSpecies, {
      division: 'EnsemblFungi',
      nameContains: 'saccharomyces',
    });
    const sc = result.structuredContent as PageSc;
    expect(mockListSpecies).toHaveBeenLastCalledWith('EnsemblFungi', expect.anything());
    expect(sc.totalCount).toBe(132);
    expect(sc.species).toHaveLength(50);
    expect(sc.species.every((s) => s.name.startsWith('saccharomyces_'))).toBe(true);
    expect(sc.species[0]!.name).toBe('saccharomyces_001');
    expect(sc.nextOffset).toBe(50);
  });

  it.each([{ offset: -1 }, { max_results: -1 }, { offset: 1.5 }, { max_results: 2.5 }])(
    'rejects invalid paging input %o as InvalidParams on that field',
    async (input) => {
      const callsBefore = mockListSpecies.mock.calls.length;
      const result = await runToolContract(ensemblListSpecies, input);
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; data: { issues: { path: unknown[] }[] } };
        }
      ).error;
      expect(error.code).toBe(-32602);
      // The field's own bound rejects it, not an unrecognized-key check.
      expect(error.data.issues[0]!.path).toEqual(Object.keys(input));
      expect(mockListSpecies.mock.calls.length).toBe(callsBefore);
    },
  );
});

describe('ensemblListSpecies optional blanks (issue #22 regression)', () => {
  it('still accepts a blank nameContains and returns the unfiltered list', async () => {
    mockListSpecies.mockResolvedValueOnce(defaultSpecies);
    const result = await runToolContract(ensemblListSpecies, { nameContains: '' });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { totalCount: number }).totalCount).toBe(
      defaultSpecies.length,
    );
  });
});
