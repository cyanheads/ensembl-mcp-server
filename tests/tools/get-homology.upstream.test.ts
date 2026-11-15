/**
 * @fileoverview Homology identity enrichment through real HTTP and tool contracts.
 * Fixtures follow Ensembl's documented homology and batch-lookup shapes; live
 * homology was unavailable during validation.
 * @module tests/tools/get-homology.upstream.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensemblGetHomology } from '@/mcp-server/tools/definitions/get-homology.tool.js';
import { getEnsemblService, initEnsemblService } from '@/services/ensembl/ensembl-service.js';

const SOURCE = 'ENSG00000139618';
const TARGET = 'ENSMUSG00000041147';
const PROTEIN = 'ENSMUSP00000045663';
const fetchMock = vi.fn<typeof fetch>();
const homology = (ids: string[]) => ({
  data: [
    {
      id: SOURCE,
      homologies: ids.map((id) => ({
        type: 'ortholog_one2one',
        target: { id, species: 'mus_musculus', protein_id: PROTEIN, perc_id: 58.6 },
      })),
    },
  ],
});
const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content?.map((block) => (block.type === 'text' ? block.text : '')).join('\n') ?? '';
const dataOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.structuredContent as { homologs: Array<Record<string, unknown>>; notice?: string };
const rowsOf = (result: Awaited<ReturnType<typeof runToolContract>>) => dataOf(result).homologs;
const requestBodies: string[][] = [];

/** Reject on the actual signal so the real fetch/body cancellation path runs. */
function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
/** Resolves after `ms`, or rejects with the signal's reason once it aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
function pendingBody(signal: AbortSignal): Response {
  return {
    status: 200,
    headers: new Headers(),
    text: () => untilAbort(signal),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error('Unscripted fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
  requestBodies.length = 0;
  initEnsemblService({} as AppConfig, createInMemoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The network seam deliberately fails on any route outside these two endpoints. */
function route(ids: string[], lookup: (ids: string[], signal: AbortSignal) => Promise<Response>) {
  fetchMock.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/homology/')) return Response.json(homology(ids));
    if (path === '/lookup/id' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { ids: string[] };
      requestBodies.push(body.ids);
      return lookup(body.ids, init.signal!);
    }
    throw new Error(`Unscripted route ${path}`);
  });
}

describe('homology identity enrichment (issue #49)', () => {
  it('characterizes row identity, order, caps, totals and uncapped output', async () => {
    route([TARGET, TARGET, 'sparse'], async () => Response.json({}));
    const capped = await runToolContract(ensemblGetHomology, { id: SOURCE, max_results: 2 });
    expect(capped.structuredContent).toMatchObject({
      queryId: SOURCE,
      totalCount: 3,
      truncated: true,
    });
    expect(rowsOf(capped).map((row) => row.targetId)).toEqual([TARGET, TARGET]);
    expect(textOf(capped)).toContain('2 of 3');
    const uncapped = await runToolContract(ensemblGetHomology, { id: SOURCE, max_results: 0 });
    expect(rowsOf(uncapped).map((row) => row.targetId)).toEqual([TARGET, TARGET, 'sparse']);
    expect(uncapped.structuredContent).not.toHaveProperty('truncated');
  });

  it('preserves protein IDs, enriches only returned distinct gene IDs and renders both fields', async () => {
    route([TARGET, TARGET, 'not-returned'], async () =>
      Response.json({ [TARGET]: { id: TARGET, display_name: 'Brca2' } }),
    );
    const result = await runToolContract(ensemblGetHomology, { symbol: 'BRCA2', max_results: 2 });
    expect(result.isError).toBeUndefined();
    expect(requestBodies).toEqual([[TARGET]]);
    expect(rowsOf(result)).toEqual([
      expect.objectContaining({
        targetId: TARGET,
        targetSymbol: 'Brca2',
        targetProteinId: PROTEIN,
      }),
      expect.objectContaining({
        targetId: TARGET,
        targetSymbol: 'Brca2',
        targetProteinId: PROTEIN,
      }),
    ]);
    expect(textOf(result)).toContain('Brca2');
    expect(textOf(result)).toContain(PROTEIN);
    expect(result.structuredContent).toMatchObject({ totalCount: 3, truncated: true });
  });

  it('retains sparse rows, null records and unresolved names without invented fields', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: SOURCE,
              homologies: [
                { id: 'sparse' },
                { target: { id: TARGET, protein_id: PROTEIN } },
                { id: 'missing-name' },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          sparse: null,
          [TARGET]: { id: TARGET },
          'missing-name': { id: 'missing-name', display_name: '' },
        }),
      );
    const result = await runToolContract(ensemblGetHomology, { id: SOURCE });
    expect(rowsOf(result)).toHaveLength(3);
    expect(rowsOf(result)[0]).not.toHaveProperty('targetProteinId');
    expect(rowsOf(result).every((row) => !Object.hasOwn(row, 'targetSymbol'))).toBe(true);
    expect(dataOf(result).notice).toContain('3 returned homologs');
    expect(textOf(result)).toContain(String(dataOf(result).notice));
    expect(textOf(result)).toContain(PROTEIN);
  });

  it('retains primary homologs when a lookup name has an invalid upstream shape', async () => {
    route([TARGET], async () => Response.json({ [TARGET]: { display_name: 123 } }));
    const result = await runToolContract(ensemblGetHomology, { id: SOURCE });
    expect(result.isError).toBeUndefined();
    expect(rowsOf(result)).toHaveLength(1);
    expect(rowsOf(result)[0]).not.toHaveProperty('targetSymbol');
    expect(textOf(result)).toContain(PROTEIN);
  });

  it('chunks every distinct ID five to a request without capping or deduplicating primary rows', async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `target-${i}`);
    route([...ids, ids[0]!], async (chunk) =>
      Response.json(Object.fromEntries(chunk.map((id) => [id, { display_name: `name-${id}` }]))),
    );
    const result = await runToolContract(ensemblGetHomology, { id: SOURCE, max_results: 0 });
    expect(requestBodies.map((chunk) => chunk.length)).toEqual([...Array(400).fill(5), 1]);
    expect(requestBodies.flat()).toEqual(ids);
    expect(rowsOf(result)).toHaveLength(2002);
    expect(rowsOf(result).at(-1)?.targetSymbol).toBe('name-target-0');
    expect(result.structuredContent).toMatchObject({ totalCount: 2002 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('name-target-2000');
  });

  it.each(['headers', 'body'] as const)(
    'bounds stalled lookup %s at ten seconds and retains every primary row',
    async (stage) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      route([TARGET], async (_ids, supplied) => {
        signal = supplied;
        return stage === 'headers' ? untilAbort(supplied) : pendingBody(supplied);
      });
      let settled = false;
      const pending = runToolContract(ensemblGetHomology, { id: SOURCE }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.isError).toBeUndefined();
      expect(rowsOf(result)).toHaveLength(1);
      expect(rowsOf(result)[0]?.targetProteinId).toBe(PROTEIN);
      expect(signal?.aborted).toBe(true);
      expect(requestBodies).toEqual([[TARGET]]);
      expect(vi.getTimerCount()).toBe(0);
      expect(dataOf(result).notice).toContain('1 returned homologs');
      expect(textOf(result)).toContain(String(dataOf(result).notice));
    },
  );

  it.each(['503', '429', 'failed body'] as const)(
    'never retries optional %s failures and composes cap guidance',
    async (failure) => {
      route([TARGET, 'capped'], async () => {
        if (failure === 'failed body')
          return {
            status: 200,
            headers: new Headers(),
            text: async () => {
              throw new Error('body disconnected');
            },
          } as unknown as Response;
        return Response.json(
          { error: 'Unavailable' },
          { status: Number(failure), headers: { 'Retry-After': '30' } },
        );
      });
      const result = await runToolContract(ensemblGetHomology, { id: SOURCE, max_results: 1 });
      expect(result.isError).toBeUndefined();
      expect(requestBodies).toEqual([[TARGET]]);
      expect(result.structuredContent).toMatchObject({
        totalCount: 2,
        shown: 1,
        truncated: true,
        cap: 1,
      });
      expect(dataOf(result).notice).toContain('1 of 2 homologs');
      expect(dataOf(result).notice).toContain('Target symbols are unavailable');
      expect(textOf(result)).toContain(String(dataOf(result).notice));
    },
  );

  describe('a default page of 25 rows, looked up five IDs a request, three at a time', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `target-${i}`);
    const chunksOf = (from: number, to: number) =>
      Array.from({ length: (to - from) / 5 }, (_, i) => ids.slice(from + i * 5, from + i * 5 + 5));
    const named = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      rowsOf(result)
        .filter((row) => row.targetSymbol)
        .map((row) => row.targetId);
    const answer = (chunk: string[]) =>
      Response.json(Object.fromEntries(chunk.map((id) => [id, { display_name: `name-${id}` }])));

    it('names every row a single 25-ID request could not answer within the budget', async () => {
      vi.useFakeTimers();
      let inFlight = 0;
      let peak = 0;
      // Ensembl answers a cross-species lookup about one ID at a time: 400 ms each here, so
      // one 25-ID request takes 10 s and a 5-ID chunk 2 s.
      route(ids, async (chunk, signal) => {
        peak = Math.max(peak, ++inFlight);
        try {
          await delay(400 * chunk.length, signal);
        } finally {
          inFlight--;
        }
        return answer(chunk);
      });
      const start = Date.now();
      let settledAt: number | undefined;
      const pending = runToolContract(ensemblGetHomology, { id: SOURCE }).then((result) => {
        settledAt = Date.now() - start;
        return result;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(requestBodies).toEqual(chunksOf(0, 25));
      expect(peak).toBe(3);
      // Two rounds of 2 s: three chunks, then the remaining two.
      expect(settledAt).toBe(4000);
      expect(named(result)).toEqual(ids);
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(textOf(result)).toContain('**Gene symbol:** name-target-24');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('shares one ten-second budget across chunks and keeps the names that arrived', async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      route(ids, async (chunk, signal) => {
        signals.push(signal);
        if (requestBodies.length > 1) return pendingBody(signal);
        await delay(4000, signal);
        return answer(chunk);
      });
      let settled = false;
      const pending = runToolContract(ensemblGetHomology, { id: SOURCE }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      // Three chunks start together; the first worker takes a fourth when its chunk answers.
      expect(requestBodies).toEqual(chunksOf(0, 20));
      expect(rowsOf(result)).toHaveLength(25);
      expect(named(result)).toEqual(ids.slice(0, 5));
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(dataOf(result).notice).toContain(
        'Target symbols are unavailable for 20 returned homologs',
      );
      expect(textOf(result)).toContain(String(dataOf(result).notice));
      expect(vi.getTimerCount()).toBe(0);
    });

    it('starts no chunk after one fails and keeps the names already answered', async () => {
      vi.useFakeTimers();
      route(ids, async (chunk, signal) => {
        if (chunk[0] === 'target-5') {
          return Response.json({ error: 'Unavailable' }, { status: 503 });
        }
        await delay(1000, signal);
        return answer(chunk);
      });
      const pending = runToolContract(ensemblGetHomology, { id: SOURCE });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.isError).toBeUndefined();
      // The failed chunk is not retried, and the two in flight beside it finish.
      expect(requestBodies).toEqual(chunksOf(0, 15));
      expect(named(result)).toEqual([...ids.slice(0, 5), ...ids.slice(10, 15)]);
      expect(dataOf(result).notice).toContain(
        'Target symbols are unavailable for 15 returned homologs',
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it('propagates caller cancellation to every chunk in flight and starts no other', async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      route(ids, async (_chunk, signal) => {
        signals.push(signal);
        return untilAbort(signal);
      });
      const controller = new AbortController();
      const pending = runToolContract(
        ensemblGetHomology,
        { id: SOURCE },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException('Caller stopped homology', 'AbortError'));
      const result = await pending;
      expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
      expect(result.structuredContent).not.toHaveProperty('homologs');
      expect(requestBodies).toEqual(chunksOf(0, 15));
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it.each(['headers', 'body'] as const)(
    'propagates caller cancellation during lookup %s instead of degraded success',
    async (stage) => {
      vi.useFakeTimers();
      let lookupSignal: AbortSignal | undefined;
      route([TARGET], async (_ids, signal) => {
        lookupSignal = signal;
        return stage === 'headers' ? untilAbort(signal) : pendingBody(signal);
      });
      const controller = new AbortController();
      const pending = runToolContract(
        ensemblGetHomology,
        { id: SOURCE },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException('Caller stopped homology', 'AbortError'));
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
      expect(result.structuredContent).not.toHaveProperty('homologs');
      expect(textOf(result)).toContain('Caller stopped homology');
      expect(lookupSignal?.aborted).toBe(true);
      expect(requestBodies).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  /*
   * Through the tool, the framework reports any settle after the abort as RequestCancelled,
   * so the cases above pass whether or not the lookup rethrows. The service is where the
   * cancellation must surface.
   */
  it.each(['headers', 'body'] as const)(
    'rejects the name lookup with the caller cancellation during %s, never partial names',
    async (stage) => {
      vi.useFakeTimers();
      route([TARGET], async (_ids, signal) =>
        stage === 'headers' ? untilAbort(signal) : pendingBody(signal),
      );
      const controller = new AbortController();
      const lookup = getEnsemblService().getHomologyTargetSymbols(
        [TARGET],
        createMockContext({ signal: controller.signal }),
      );
      const settled = lookup.then(
        (names) => ({ names }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException('Caller stopped homology', 'AbortError'));
      const outcome = await settled;
      expect(outcome).not.toHaveProperty('names');
      expect(String((outcome as { error: unknown }).error)).toContain('Caller stopped homology');
      expect(requestBodies).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not renew the 240-second primary call deadline for enrichment', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let attempts = 0;
    let lookupSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname.startsWith('/homology/')) {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, attempts === 1 ? 179000 : 59000));
        return attempts === 1
          ? Response.json({ error: 'Unavailable' }, { status: 503 })
          : Response.json(homology([TARGET]));
      }
      lookupSignal = init!.signal!;
      return pendingBody(lookupSignal);
    });
    const start = Date.now();
    let settledAt: number | undefined;
    const pending = runToolContract(ensemblGetHomology, { id: SOURCE }).then((result) => {
      settledAt = Date.now() - start;
      return result;
    });
    await vi.advanceTimersByTimeAsync(239999);
    expect(settledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(settledAt).toBe(240000);
    expect(result.isError).toBeUndefined();
    expect(rowsOf(result)).toHaveLength(1);
    expect(lookupSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('looks up names only for the rows on the requested page (#64)', async () => {
    route(['t0', 't1', 't2', 't3'], async (chunk) =>
      Response.json(Object.fromEntries(chunk.map((id) => [id, { display_name: `name-${id}` }]))),
    );
    const result = await runToolContract(ensemblGetHomology, {
      id: SOURCE,
      offset: 2,
      max_results: 1,
    });
    expect(requestBodies).toEqual([['t2']]);
    expect(rowsOf(result)).toEqual([
      expect.objectContaining({ targetId: 't2', targetSymbol: 'name-t2' }),
    ]);
    expect(result.structuredContent).toMatchObject({ totalCount: 4, nextOffset: 3 });
    expect(textOf(result)).toContain('**Gene symbol:** name-t2');
  });

  it('makes no name lookup for a page past the end (#64)', async () => {
    route(['t0', 't1', 't2'], async () => {
      throw new Error('A past-end page must not trigger enrichment');
    });
    const result = await runToolContract(ensemblGetHomology, { id: SOURCE, offset: 3 });
    expect(result.isError).toBeUndefined();
    expect(rowsOf(result)).toEqual([]);
    expect(requestBodies).toEqual([]);
    expect(result.structuredContent).toMatchObject({ totalCount: 3 });
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips enrichment for empty primary results', async () => {
    route([], async () => {
      throw new Error('Empty results must not trigger enrichment');
    });
    const result = await runToolContract(ensemblGetHomology, { id: SOURCE, max_results: 0 });
    expect(result.isError).toBeUndefined();
    expect(rowsOf(result)).toEqual([]);
    expect(requestBodies).toEqual([]);
    expect(textOf(result)).toContain('No homologs found');
  });

  it('makes no secondary request when the original deadline is already exhausted', async () => {
    vi.useFakeTimers();
    route([TARGET], async () => {
      throw new Error('No secondary budget remains');
    });
    const ctx = createMockContext();
    const service = getEnsemblService();
    const primary = await service.getHomologyById(
      SOURCE,
      'homo_sapiens',
      'orthologues',
      undefined,
      ctx,
    );
    vi.setSystemTime(Date.now() + 240000);
    expect(
      await service.getHomologyTargetSymbols(
        primary.homologs.map((row) => row.targetId),
        ctx,
      ),
    ).toEqual(new Map());
    expect(requestBodies).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation between primary completion and optional enrichment', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(new DOMException('Caller stopped before enrichment', 'AbortError'));
      return Response.json(homology([TARGET]));
    });
    const result = await runToolContract(
      ensemblGetHomology,
      { id: SOURCE },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect(result.structuredContent).not.toHaveProperty('homologs');
    expect(textOf(result)).toContain('Caller stopped before enrichment');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
