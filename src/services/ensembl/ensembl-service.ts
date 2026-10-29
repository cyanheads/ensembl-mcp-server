/**
 * @fileoverview Ensembl REST API service — HTTP client, rate-limit-aware retry,
 * error normalization, and typed methods per endpoint family.
 * @module services/ensembl/ensembl-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { type RetryAttempt, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AliasResolution,
  EnsemblErrorEnvelope,
  GeneRecord,
  HomologyEntry,
  HomologyResult,
  MitochondrionAliasCheck,
  OverlapFeature,
  RawAssemblyInfo,
  RawGeneRecord,
  RawHomologyResponse,
  RawOverlapFeature,
  RawRegionInfo,
  RawSequenceRecord,
  RawSpeciesResponse,
  RawSpeciesSet,
  RawTranscriptRecord,
  RawVepRecord,
  RawXrefEntry,
  RawXrefSymbolEntry,
  SequenceRecord,
  SpeciesInfo,
  TranscriptRecord,
  VepRecord,
  XrefEntry,
} from './types.js';

// --- Upstream request bounds ---

/**
 * Bound on one Ensembl request attempt — response headers and the full body read
 * together. Sized above the slowest successful response measured against
 * rest.ensembl.org; docs/design.md records the measurements.
 */
export const ENSEMBL_ATTEMPT_TIMEOUT_MS = 180_000;

/**
 * Bound on one tool call as a whole: every upstream request it makes, with every
 * attempt and retry backoff. Leaves room after one full-length attempt for a
 * retry of a fast failure.
 */
export const ENSEMBL_CALL_DEADLINE_MS = 240_000;

// --- Response classification ---

/** Ensembl's error text when its REST server cannot reach the backing database. */
const DATABASE_OUTAGE = /could not connect to database|DBI connect/i;

/**
 * The location Perl appends to an uncaught `die` ("… at /path/Module.pm line 121."):
 * the request crashed inside Ensembl's own code rather than being rejected.
 */
const PERL_DIE_LOCATION = / at \/\S+ line \d+/;

/** Ensembl's answer for a sequence-region name a species does not resolve. */
const NO_SLICE = /^No slice found for location/i;

/**
 * How Ensembl's homology endpoints open their answer when `target_species` names no genome
 * in the comparison Ensembl runs for the source species. Matched as a prefix of the whole
 * message: Ensembl's wording, never this service's.
 */
const GENOMEDB_MISS = "Could not find a GenomeDB named '";

/** The species Ensembl's pan-taxonomic comparison holds, across every division. */
const PAN_HOMOLOGY_SPECIES_PATH = '/info/compara/species_sets/PROTEIN_TREES?compara=pan_homology';

/**
 * Waits on a load other calls may share, for one call: the load's answer, or a rejection
 * once this call is cancelled or `remainingMs` passes. Leaving early stops nothing; the
 * load's owner decides that.
 */
function awaitShared<T>(load: Promise<T>, signal: AbortSignal, remainingMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            timeout(`Ensembl request exceeded its ${ENSEMBL_CALL_DEADLINE_MS}ms call deadline.`, {
              deadlineMs: ENSEMBL_CALL_DEADLINE_MS,
            }),
          ),
        ),
      Math.max(0, remainingMs),
    );
    load.then(
      (value) => settle(() => resolve(value)),
      (err: unknown) => settle(() => reject(err)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Names ---

/**
 * An Ensembl stable ID with a trailing version (ENSG00000139618.19). Ensembl's stable-ID
 * endpoints answer a versioned ID as not found, even its current version, and
 * `/homology/id` answers it with an empty list, so the version is dropped before every
 * stable-ID request. A non-Ensembl ID (AT3G52430.1, whose suffix is part of the ID) never
 * matches. Anchored, with the letter run, digit run, and suffix in disjoint classes, so
 * matching is linear in the input.
 */
const VERSIONED_STABLE_ID = /^(ENS[A-Z]*\d{11})\.\d+$/i;

/** The ID without its version when it is a versioned Ensembl stable ID; otherwise unchanged. */
function unversioned(id: string): string {
  return id.replace(VERSIONED_STABLE_ID, '$1');
}

/**
 * A sequence-region name or synonym that names a mitochondrion: MT, Mt, Mito, MtDNA, M,
 * chrM, mitochondrion_genome. Anchored literal alternatives, so linear in the input.
 */
const MITOCHONDRION_NAME = /^(?:(?:chr)?(?:m|mt|mito|mtdna)|mitochondri(?:on|al)(?:_genome)?)$/i;

/**
 * Turns an Ensembl response body into the parsed payload or a classified error.
 * Ensembl answers every caught exception with an `{ error }` envelope, usually on
 * HTTP 400 whether the cause was the request or its own backend, so the message
 * decides first and the status only for messages no pattern recognizes. Input
 * errors keep Ensembl's message unchanged: the tools map them by its text.
 */
function parseEnsemblBody<T>(status: number, text: string): T {
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable(
      'Ensembl API returned HTML instead of JSON — service may be degraded.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Worded to match no tool's input-error pattern ("parse", "invalid", "malformed").
    throw serviceUnavailable('Ensembl API returned a response that is not JSON.', { status });
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'error' in parsed &&
    typeof (parsed as EnsemblErrorEnvelope).error === 'string'
  ) {
    const msg = (parsed as EnsemblErrorEnvelope).error;
    if (DATABASE_OUTAGE.test(msg)) {
      // Ensembl's text carries its database DSN and server paths: it rides `cause`
      // into the log, never the message or data a caller sees.
      throw serviceUnavailable(
        'Ensembl is temporarily unavailable: its REST server lost its database connection.',
        {
          status,
          recovery: {
            hint: 'Retry the call in a minute or two. This is an Ensembl outage, not a problem with the request.',
          },
        },
        { cause: new Error(msg) },
      );
    }
    if (PERL_DIE_LOCATION.test(msg)) {
      // The text names Ensembl's server paths; like an outage's, it stays in the log.
      throw serviceUnavailable(
        'Ensembl hit an internal error answering this request.',
        { status },
        { cause: new Error(msg) },
      );
    }
    if (/not found|not exist|does not exist|no stable id/i.test(msg)) {
      throw notFound(msg);
    }
    if (/invalid|unrecognized|malformed|bad request/i.test(msg)) {
      throw validationError(msg);
    }
    if (status === 404) throw notFound(msg);
    if (status >= 500) {
      throw serviceUnavailable(
        `Ensembl API returned HTTP ${status}.`,
        { status },
        { cause: new Error(msg) },
      );
    }
    throw validationError(msg);
  }

  if (status < 200 || status > 299) {
    throw serviceUnavailable(`Ensembl API returned HTTP ${status}.`, { status });
  }

  return parsed as T;
}

// --- Normalizers ---

function normalizeGene(raw: RawGeneRecord): GeneRecord {
  const desc = raw.description?.split('[')[0]?.trim();
  // Ensembl builds canonical_transcript as `<id>.<version>` and leaves the version empty for
  // transcripts without one (`FBtr0084360.`, `AT2G18790.1.`); drop that dot so the ID chains.
  const canonical = raw.canonical_transcript?.endsWith('.')
    ? raw.canonical_transcript.slice(0, -1)
    : raw.canonical_transcript;
  return {
    id: raw.id,
    ...(canonical && { canonicalTranscript: canonical }),
    ...(raw.object_type === 'Transcript' && raw.Parent && { parentGeneId: raw.Parent }),
    ...(raw.species && { species: raw.species }),
    ...(raw.display_name && { displayName: raw.display_name }),
    ...(desc ? { description: desc } : {}),
    ...(raw.biotype && { biotype: raw.biotype }),
    ...(raw.seq_region_name && { chromosome: raw.seq_region_name }),
    ...(typeof raw.start === 'number' && { start: raw.start }),
    ...(typeof raw.end === 'number' && { end: raw.end }),
    ...(typeof raw.strand === 'number' && { strand: raw.strand }),
    ...(raw.assembly_name && { assemblyName: raw.assembly_name }),
    ...(raw.Transcript && {
      transcripts: raw.Transcript.map((t) => {
        const maneSelect = t.MANE?.find((entry) => entry.type === 'MANE_Select')?.refseq_match;
        return {
          id: t.id,
          ...(maneSelect && { maneSelect }),
          ...(t.display_name && { displayName: t.display_name }),
          ...(t.biotype && { biotype: t.biotype }),
          isCanonical: t.is_canonical === 1,
          ...(typeof t.start === 'number' && { start: t.start }),
          ...(typeof t.end === 'number' && { end: t.end }),
          ...(typeof t.strand === 'number' && { strand: t.strand }),
          ...(typeof t.length === 'number' && { lengthInBp: t.length }),
        };
      }),
    }),
  };
}

function normalizeTranscript(raw: RawTranscriptRecord): TranscriptRecord {
  return {
    id: raw.id,
    ...(raw.Parent && { parentGeneId: raw.Parent }),
    ...(raw.display_name && { displayName: raw.display_name }),
    ...(raw.biotype && { biotype: raw.biotype }),
    isCanonical: raw.is_canonical === 1,
    ...(raw.species && { species: raw.species }),
    ...(raw.seq_region_name && { chromosome: raw.seq_region_name }),
    ...(typeof raw.start === 'number' && { start: raw.start }),
    ...(typeof raw.end === 'number' && { end: raw.end }),
    ...(typeof raw.strand === 'number' && { strand: raw.strand }),
    ...(raw.assembly_name && { assemblyName: raw.assembly_name }),
    ...(typeof raw.length === 'number' && { lengthInBp: raw.length }),
  };
}

function normalizeSequence(raw: RawSequenceRecord, type: string): SequenceRecord {
  return {
    id: raw.id,
    type,
    seq: raw.seq,
    length: raw.seq.length,
    ...(raw.molecule && { molecule: raw.molecule }),
    ...(raw.desc && { description: raw.desc }),
  };
}

function normalizeOverlapFeature(raw: RawOverlapFeature): OverlapFeature {
  return {
    ...(raw.id && { id: raw.id }),
    ...(raw.external_name && { name: raw.external_name }),
    featureType: raw.feature_type ?? 'unknown',
    ...(raw.biotype && { biotype: raw.biotype }),
    chromosome: raw.seq_region_name ?? '',
    start: raw.start ?? 0,
    end: raw.end ?? 0,
    ...(typeof raw.strand === 'number' && { strand: raw.strand }),
    ...(raw.assembly_name && { assemblyName: raw.assembly_name }),
    ...(raw.description && { description: raw.description }),
    ...(raw.consequence_type && { consequenceType: raw.consequence_type }),
    ...(raw.clinical_significance?.length && {
      clinicalSignificance: raw.clinical_significance,
    }),
    // Parent + rank are exon-specific here: an exon's Parent is its transcript.
    // Other overlap types reuse `Parent` with different semantics (a transcript's
    // Parent is its gene), so scope these to exons to avoid mislabeling other modes.
    ...(raw.feature_type === 'exon' && raw.Parent && { parentId: raw.Parent }),
    ...(raw.feature_type === 'exon' && typeof raw.rank === 'number' && { rank: raw.rank }),
  };
}

function normalizeVep(raw: RawVepRecord): VepRecord {
  return {
    ...(raw.allele_string && { alleleString: raw.allele_string }),
    ...(raw.input && { input: raw.input }),
    ...(raw.seq_region_name && { chromosome: raw.seq_region_name }),
    ...(typeof raw.start === 'number' && { start: raw.start }),
    ...(typeof raw.end === 'number' && { end: raw.end }),
    ...(raw.assembly_name && { assemblyName: raw.assembly_name }),
    ...(raw.most_severe_consequence && {
      mostSevereConsequence: raw.most_severe_consequence,
    }),
    transcriptConsequences: (raw.transcript_consequences ?? []).map((tc) => ({
      ...(tc.variant_allele && { variantAllele: tc.variant_allele }),
      ...(typeof tc.canonical === 'number' && { canonical: tc.canonical === 1 }),
      ...(tc.mane_select && { maneSelect: tc.mane_select }),
      ...(tc.transcript_id && { transcriptId: tc.transcript_id }),
      ...(tc.gene_id && { geneId: tc.gene_id }),
      ...(tc.gene_symbol && { geneSymbol: tc.gene_symbol }),
      consequenceTerms: tc.consequence_terms ?? [],
      ...(tc.impact && { impact: tc.impact }),
      ...(tc.biotype && { biotype: tc.biotype }),
      ...(tc.hgvsc && { hgvsc: tc.hgvsc }),
      ...(tc.hgvsp && { hgvsp: tc.hgvsp }),
      ...(tc.amino_acids && { aminoAcids: tc.amino_acids }),
      ...(tc.sift_prediction && typeof tc.sift_score === 'number'
        ? { sift: { prediction: tc.sift_prediction, score: tc.sift_score } }
        : tc.sift && { sift: tc.sift }),
      ...(tc.polyphen_prediction && typeof tc.polyphen_score === 'number'
        ? { polyphen: { prediction: tc.polyphen_prediction, score: tc.polyphen_score } }
        : tc.polyphen && { polyphen: tc.polyphen }),
    })),
    colocatedVariants: (raw.colocated_variants ?? []).map((cv) => {
      const termsByAllele = new Map<string, string[]>();
      for (const segment of cv.clin_sig_allele?.split(';') ?? []) {
        const [allele, term, ...extra] = segment.split(':').map((part) => part.trim());
        if (!allele || !term || extra.length > 0) continue;
        const terms = termsByAllele.get(allele) ?? [];
        terms.push(term);
        termsByAllele.set(allele, terms);
      }
      const clinicalSignificance = cv.clin_sig ?? cv.clinical_significance;
      return {
        ...(cv.id && { id: cv.id }),
        ...(cv.allele_string && { alleleString: cv.allele_string }),
        ...(clinicalSignificance?.length && { clinicalSignificance }),
        ...(termsByAllele.size > 0 && {
          clinicalSignificanceByAllele: Object.fromEntries(termsByAllele),
        }),
        ...(cv.clin_sig_ref_allele && {
          clinicalSignificanceReferenceAllele: cv.clin_sig_ref_allele,
        }),
        ...(cv.pubmed?.length && { pubmed: cv.pubmed }),
      };
    }),
  };
}

function normalizeHomology(raw: RawHomologyResponse, sourceId: string): HomologyResult {
  const dataEntry = raw.data?.find((d) => d.id === sourceId) ?? raw.data?.[0];
  const homologs: HomologyEntry[] = (dataEntry?.homologies ?? []).map((h) => ({
    targetId: h.target?.id ?? h.id,
    ...(h.target?.protein_id && { targetProteinId: h.target.protein_id }),
    ...(h.target?.species
      ? { targetSpecies: h.target.species }
      : h.species
        ? { targetSpecies: h.species }
        : {}),
    ...(h.type && { type: h.type }),
    ...(typeof (h.target?.perc_id ?? h.perc_id) === 'number' && {
      percId: h.target?.perc_id ?? h.perc_id,
    }),
    ...(typeof (h.target?.perc_pos ?? h.perc_pos) === 'number' && {
      percPos: h.target?.perc_pos ?? h.perc_pos,
    }),
    ...(h.taxonomy_level && { taxonomyLevel: h.taxonomy_level }),
  }));
  // dataEntry.id is the Ensembl stable gene ID the query resolved to — surface it
  // so symbol-mode callers get a chainable stable ID, not the echoed symbol.
  return {
    homologs,
    ...(dataEntry?.id && { resolvedQueryId: dataEntry.id }),
  };
}

function normalizeXref(raw: RawXrefEntry): XrefEntry {
  return {
    ...(raw.dbname && { dbname: raw.dbname }),
    ...(raw.db_display_name && { dbDisplayName: raw.db_display_name }),
    ...(raw.primary_id && { primaryId: raw.primary_id }),
    ...(raw.display_id && { displayId: raw.display_id }),
    ...(raw.description && { description: raw.description }),
    ...(raw.info_type && { infoType: raw.info_type }),
    ...(raw.info_text && { infoText: raw.info_text }),
    ...(raw.linkage_types?.length ? { linkageTypes: raw.linkage_types } : {}),
  };
}

function normalizeSpecies(raw: RawSpeciesResponse): SpeciesInfo[] {
  return (raw.species ?? []).map((s) => ({
    name: s.name ?? '',
    ...(s.display_name && { displayName: s.display_name }),
    ...(s.common_name && { commonName: s.common_name }),
    ...(s.taxon_id && { taxonId: s.taxon_id }),
    ...(s.assembly && { assembly: s.assembly }),
    ...(s.division && { division: s.division }),
  }));
}

// --- Service ---

/** Most `/xrefs/symbol` requests in flight at once while resolving a batch's misses. */
const XREF_CONCURRENCY = 4;

interface RequestOptions {
  body?: unknown;
  method?: 'GET' | 'POST';
}

/** A species read shared by concurrent calls; `stop` aborts it once no call waits on it. */
interface PanHomologyLoad {
  species: Promise<ReadonlySet<string>>;
  stop: AbortController;
  waiters: number;
}

export class EnsemblService {
  private readonly baseUrl: string;
  /**
   * Default assembly per species for this process. The endpoint's assembly can
   * only change with a restart under a different ENSEMBL_BASE_URL, so a resolved
   * value is kept for the process lifetime; failed lookups are never stored.
   */
  private readonly defaultAssemblies = new Map<string, string>();
  /**
   * Reference top-level region names per species (chromosomes and unplaced
   * scaffolds, never patch or haplotype regions), kept for the process lifetime
   * on the same grounds as defaultAssemblies.
   */
  private readonly referenceRegions = new Map<string, Set<string>>();
  /**
   * Per species and `M`/`chrM` spelling, whether Ensembl resolves it to the
   * mitochondrion, kept for the process lifetime on the same grounds.
   */
  private readonly mitochondrionAliases = new Map<string, boolean>();
  /**
   * When each tool call's first upstream request started, keyed by the call's
   * Context: every later request of the call spends the same
   * {@link ENSEMBL_CALL_DEADLINE_MS} budget.
   */
  private readonly callStarts = new WeakMap<Context, number>();
  /**
   * The species in Ensembl's pan-taxonomic comparison, lowercased, kept for the process
   * lifetime on the same grounds as defaultAssemblies once a read succeeds.
   */
  private panHomologySpecies: ReadonlySet<string> | undefined;
  /** The pan-taxonomic species read in flight, shared by every call waiting on it. */
  private panHomologyLoad: PanHomologyLoad | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().baseUrl;
  }

  // --- Core fetch ---

  /**
   * One request attempt. It aborts on the first of three clocks: its own
   * {@link ENSEMBL_ATTEMPT_TIMEOUT_MS} timer, the call deadline, and the caller's
   * cancellation — the last two arrive together on `attempt.signal`. The timer
   * stays armed through the body read, so a response that sends its headers and
   * then stalls is bounded too.
   */
  private async fetchJson<T>(
    path: string,
    ctx: Context,
    options: RequestOptions | undefined,
    attempt: RetryAttempt,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options?.method ?? 'GET';
    const timer = new AbortController();
    const timerId = setTimeout(
      () =>
        timer.abort(
          new DOMException(
            `Ensembl request timed out after ${ENSEMBL_ATTEMPT_TIMEOUT_MS}ms.`,
            'TimeoutError',
          ),
        ),
      ENSEMBL_ATTEMPT_TIMEOUT_MS,
    );

    ctx.log.debug('Ensembl request', { url, method });

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        ...(options?.body !== undefined && { body: JSON.stringify(options.body) }),
        signal: AbortSignal.any([attempt.signal, timer.signal]),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw serviceUnavailable(
          `Ensembl rate limit exceeded.${retryAfter ? ` Retry after ${retryAfter}s.` : ''}`,
          { retryAfter: retryAfter ? Number(retryAfter) : undefined },
        );
      }

      return parseEnsemblBody<T>(response.status, await response.text());
    } catch (err) {
      // A deadline expiry or a caller cancellation propagates as thrown, so withRetry
      // can tell them apart; only this attempt's own timer becomes a (retryable) Timeout.
      if (err instanceof McpError || attempt.signal.aborted) throw err;
      if (timer.signal.aborted) {
        throw timeout(
          `Ensembl did not respond within ${ENSEMBL_ATTEMPT_TIMEOUT_MS / 1000}s.`,
          { timeoutMs: ENSEMBL_ATTEMPT_TIMEOUT_MS },
          { cause: err },
        );
      }
      // A transport failure (refused, reset, DNS) names the upstream host: it rides
      // `cause` into the log and the caller gets a retryable error without it.
      throw serviceUnavailable('Ensembl could not be reached.', undefined, { cause: err });
    } finally {
      clearTimeout(timerId);
    }
  }

  // --- withRetry wrapper ---

  private async fetchWithRetry<T>(
    path: string,
    ctx: Context,
    options?: RequestOptions,
  ): Promise<T> {
    const callStart = this.callStarts.get(ctx) ?? Date.now();
    this.callStarts.set(ctx, callStart);
    const reqCtx = requestContextService.createRequestContext({
      operation: `EnsemblService.fetch:${path.split('?')[0]}`,
      parentContext: ctx,
    });
    try {
      return await withRetry((attempt) => this.fetchJson<T>(path, ctx, options, attempt), {
        // A fixed label, not the path: a path echoes caller input the tools' message
        // patterns could misread as an input error. It rides the log context instead.
        operation: 'Ensembl request',
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: Math.max(1, callStart + ENSEMBL_CALL_DEADLINE_MS - Date.now()),
      });
    } catch (err) {
      // withRetry reports the share of the budget this request was given; the caller
      // is told the call's own deadline.
      if (err instanceof McpError && err.data?.reason === 'retry_deadline_exceeded') {
        const attempts = Number(err.data.retryAttempts);
        throw timeout(
          `Ensembl request exceeded its ${ENSEMBL_CALL_DEADLINE_MS}ms retry deadline after ` +
            `${attempts} attempt${attempts > 1 ? 's' : ''}.`,
          {
            reason: 'retry_deadline_exceeded',
            deadlineMs: ENSEMBL_CALL_DEADLINE_MS,
            elapsedMs: Date.now() - callStart,
            retryAttempts: attempts,
          },
          { cause: err },
        );
      }
      throw err;
    }
  }

  // --- Gene lookup ---

  async lookupGene(
    symbol: string,
    species: string,
    expandTranscripts: boolean,
    ctx: Context,
  ): Promise<GeneRecord> {
    const expand = expandTranscripts ? '?expand=1&mane=1' : '';
    const path = `/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}${expand}`;
    const raw = await this.fetchWithRetry<RawGeneRecord>(path, ctx);
    return normalizeGene(raw);
  }

  async lookupGeneById(id: string, expandTranscripts: boolean, ctx: Context): Promise<GeneRecord> {
    const expand = expandTranscripts ? '?expand=1&mane=1' : '';
    const path = `/lookup/id/${encodeURIComponent(unversioned(id))}${expand}`;
    const raw = await this.fetchWithRetry<RawGeneRecord>(path, ctx);
    return normalizeGene(raw);
  }

  /**
   * One `POST /lookup/id` for every ID, each sent once and unversioned. The records are
   * keyed by the IDs as given, so inputs that differ only by version share a record;
   * an ID Ensembl does not hold is absent.
   */
  async lookupGenesBatch(
    ids: string[],
    expandTranscripts: boolean,
    ctx: Context,
  ): Promise<Map<string, GeneRecord>> {
    const body: Record<string, unknown> = { ids: [...new Set(ids.map(unversioned))] };
    if (expandTranscripts) body.expand = 1;
    const path = `/lookup/id${expandTranscripts ? '?expand=1&mane=1' : ''}`;
    const raw = await this.fetchWithRetry<Record<string, RawGeneRecord | null>>(path, ctx, {
      method: 'POST',
      body,
    });
    const result = new Map<string, GeneRecord>();
    for (const id of ids) {
      // Own keys only: a caller's ID such as "constructor" must not read the prototype.
      const key = unversioned(id);
      const record = Object.hasOwn(raw, key) ? raw[key] : null;
      if (record) result.set(id, normalizeGene(record));
    }
    return result;
  }

  async lookupSymbolsBatch(
    symbols: string[],
    species: string,
    expandTranscripts: boolean,
    ctx: Context,
  ): Promise<Map<string, GeneRecord>> {
    const body: Record<string, unknown> = { symbols };
    if (expandTranscripts) body.expand = 1;
    const raw = await this.fetchWithRetry<Record<string, RawGeneRecord | null>>(
      `/lookup/symbol/${encodeURIComponent(species)}${expandTranscripts ? '?expand=1&mane=1' : ''}`,
      ctx,
      { method: 'POST', body },
    );
    const result = new Map<string, GeneRecord>();
    for (const [k, v] of Object.entries(raw)) {
      if (v) result.set(k, normalizeGene(v));
    }
    return result;
  }

  // --- Alias resolution ---

  /**
   * Gene stable IDs a synonym, former symbol, or other external name maps to in
   * one species. LRG records are dropped: each mirrors an Ensembl gene locus.
   * Sorted, since Ensembl's own order varies between identical requests. A name
   * the endpoint cannot address — Ensembl decodes a `/` before routing and answers
   * 404 — maps to no gene.
   */
  async getGeneIdsBySymbol(symbol: string, species: string, ctx: Context): Promise<string[]> {
    const path = `/xrefs/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?object_type=gene`;
    const raw = await this.fetchWithRetry<RawXrefSymbolEntry[]>(path, ctx).catch((err: unknown) => {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return [];
      throw err;
    });
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((r) => r.id).filter((id) => id && !id.startsWith('LRG_')))].sort();
  }

  /**
   * Reference top-level region names for a species, fetched once per process. An
   * answer listing none is malformed (every species has top-level regions), so it
   * is used for this call but not kept.
   */
  async getReferenceRegions(species: string, ctx: Context): Promise<Set<string>> {
    const cached = this.referenceRegions.get(species);
    if (cached) return cached;
    const raw = await this.fetchWithRetry<RawAssemblyInfo>(
      `/info/assembly/${encodeURIComponent(species)}`,
      ctx,
    );
    const regions = new Set(
      (raw.top_level_region ?? []).flatMap((region) => (region.name ? [region.name] : [])),
    );
    if (regions.size > 0) this.referenceRegions.set(species, regions);
    return regions;
  }

  /**
   * Whether Ensembl resolves `name`, an `M` or `chrM` spelling, to the species'
   * mitochondrion. It answers these names per species and per spelling: the
   * mitochondrion in Drosophila, an unrelated scaffold or contig in human, mouse, and
   * C. elegans (a different one between calls), or no region at all. `/info/assembly`
   * resolves a name as the sequence and overlap endpoints do; the region it lands on is
   * the mitochondrion when one of its synonyms names one. A verdict is kept for the
   * process lifetime. A failing name also carries the species' mitochondrion when one of
   * its reference regions is recognizably named so — a lookup that degrades to no name.
   */
  async checkMitochondrionAlias(
    species: string,
    name: string,
    ctx: Context,
  ): Promise<MitochondrionAliasCheck> {
    const key = `${species}\u0000${name}`;
    let resolves = this.mitochondrionAliases.get(key);
    if (resolves === undefined) {
      resolves = await this.fetchWithRetry<RawRegionInfo>(
        `/info/assembly/${encodeURIComponent(species)}/${encodeURIComponent(name)}?synonyms=1`,
        ctx,
      ).then(
        (raw) => (raw.synonyms ?? []).some((s) => MITOCHONDRION_NAME.test(s.name ?? '')),
        (err: unknown) => {
          if (err instanceof McpError && NO_SLICE.test(err.message)) return false;
          throw err;
        },
      );
      this.mitochondrionAliases.set(key, resolves);
    }
    if (resolves) return { resolves };

    const mitochondrion = await this.getReferenceRegions(species, ctx).then(
      (regions) => [...regions].find((region) => MITOCHONDRION_NAME.test(region)),
      (err: unknown) => {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('Reference region lookup failed', {
          species,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      },
    );
    return { resolves: false, ...(mitochondrion && { mitochondrion }) };
  }

  /**
   * Resolve symbols `/lookup/symbol` missed through `/xrefs/symbol`: at most
   * XREF_CONCURRENCY xref requests in flight, one `POST /lookup/id` for every
   * candidate, and — only when a symbol still maps to several genes — the
   * species' reference regions, which drop patch and haplotype copies unless
   * that would drop them all; regions that cannot be read leave every candidate
   * in place. With `verifySpeciesFirst`, the first symbol's xref request runs
   * alone, so an unrecognized species fails once rather than once per symbol.
   *
   * A request Ensembl leaves unanswered through every retry marks only the symbols
   * that needed it `unavailable`; the rest still resolve. An unanswered species check
   * proves nothing about the species, so the remaining requests run and an unknown
   * species fails them. Any other failure, and a cancellation, fails the resolution.
   */
  async resolveSymbolAliases(
    symbols: string[],
    species: string,
    expandTranscripts: boolean,
    ctx: Context,
    verifySpeciesFirst = false,
  ): Promise<Map<string, AliasResolution>> {
    const unanswered = (err: unknown): err is McpError =>
      !ctx.signal.aborted &&
      err instanceof McpError &&
      (err.code === JsonRpcErrorCode.ServiceUnavailable || err.code === JsonRpcErrorCode.Timeout);

    const idsBySymbol = new Map<string, string[]>();
    const unavailable = new Map<string, McpError>();
    const pending = [...symbols];
    const resolveNext = async (symbol: string) => {
      try {
        idsBySymbol.set(symbol, await this.getGeneIdsBySymbol(symbol, species, ctx));
      } catch (err) {
        if (!unanswered(err)) throw err;
        unavailable.set(symbol, err);
      }
    };
    const first = verifySpeciesFirst ? pending.shift() : undefined;
    if (first !== undefined) await resolveNext(first);
    const worker = async () => {
      for (let symbol = pending.shift(); symbol !== undefined; symbol = pending.shift()) {
        await resolveNext(symbol).catch((err: unknown) => {
          // One failure fails the whole resolution: the other workers start nothing more.
          pending.length = 0;
          throw err;
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(XREF_CONCURRENCY, pending.length) }, worker));

    const candidateIds = [...new Set([...idsBySymbol.values()].flat())];
    let genes = new Map<string, GeneRecord>();
    if (candidateIds.length > 0) {
      try {
        genes = await this.lookupGenesBatch(candidateIds, expandTranscripts, ctx);
      } catch (err) {
        if (!unanswered(err)) throw err;
        for (const [symbol, ids] of idsBySymbol) {
          if (ids.length > 0) unavailable.set(symbol, err);
        }
      }
    }

    // Read at most once per call. The filter only narrows candidates that are already
    // a truthful answer, so a failed read skips it rather than failing the call.
    let referenceRegions: Promise<Set<string>> | undefined;
    const readReferenceRegions = () =>
      (referenceRegions ??= this.getReferenceRegions(species, ctx).catch((err: unknown) => {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('Reference region lookup failed', {
          species,
          error: err instanceof Error ? err.message : String(err),
        });
        return new Set<string>();
      }));

    const result = new Map<string, AliasResolution>();
    for (const symbol of symbols) {
      const error = unavailable.get(symbol);
      if (error) {
        result.set(symbol, { kind: 'unavailable', error });
        continue;
      }
      let matches = (idsBySymbol.get(symbol) ?? [])
        .map((id) => genes.get(id))
        .filter((gene): gene is GeneRecord => gene !== undefined);
      if (matches.length > 1) {
        const regions = await readReferenceRegions();
        const onReference = matches.filter((gene) => regions.has(gene.chromosome ?? ''));
        if (onReference.length > 0) matches = onReference;
      }
      const [only] = matches;
      result.set(
        symbol,
        matches.length > 1
          ? { kind: 'ambiguous', candidates: matches }
          : only
            ? { kind: 'gene', gene: only }
            : { kind: 'none' },
      );
    }
    return result;
  }

  // --- Transcript lookup ---

  async lookupTranscript(id: string, ctx: Context): Promise<TranscriptRecord> {
    const path = `/lookup/id/${encodeURIComponent(unversioned(id))}`;
    const raw = await this.fetchWithRetry<RawTranscriptRecord>(path, ctx);
    return normalizeTranscript(raw);
  }

  // --- Sequence ---

  async getSequenceById(
    id: string,
    type: string,
    expand5prime: number,
    expand3prime: number,
    ctx: Context,
  ): Promise<SequenceRecord> {
    const params = [`type=${encodeURIComponent(type)}`];
    // Ensembl only honors expansion when type=genomic; it is meaningless for
    // cdna/cds/protein, so gate the params to avoid sending them where the API ignores them.
    if (type === 'genomic') {
      if (expand5prime > 0) params.push(`expand_5prime=${expand5prime}`);
      if (expand3prime > 0) params.push(`expand_3prime=${expand3prime}`);
    }
    const path = `/sequence/id/${encodeURIComponent(unversioned(id))}?${params.join('&')}`;
    const raw = await this.fetchWithRetry<RawSequenceRecord>(path, ctx);
    return normalizeSequence(raw, type);
  }

  async getSequenceByRegion(
    species: string,
    region: string,
    expand5prime: number,
    expand3prime: number,
    ctx: Context,
  ): Promise<SequenceRecord> {
    let path = `/sequence/region/${encodeURIComponent(species)}/${encodeURIComponent(region)}`;
    const params: string[] = [];
    if (expand5prime > 0) params.push(`expand_5prime=${expand5prime}`);
    if (expand3prime > 0) params.push(`expand_3prime=${expand3prime}`);
    if (params.length > 0) path += `?${params.join('&')}`;
    const raw = await this.fetchWithRetry<RawSequenceRecord>(path, ctx);
    return normalizeSequence(raw, 'genomic');
  }

  // --- Overlap/region ---

  async queryRegion(
    species: string,
    region: string,
    features: string[],
    biotype: string | undefined,
    ctx: Context,
  ): Promise<OverlapFeature[]> {
    const featureParams = features.map((f) => `feature=${encodeURIComponent(f)}`).join('&');
    let path = `/overlap/region/${encodeURIComponent(species)}/${encodeURIComponent(region)}?${featureParams}`;
    if (biotype) path += `&biotype=${encodeURIComponent(biotype)}`;
    const raw = await this.fetchWithRetry<RawOverlapFeature[]>(path, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOverlapFeature);
  }

  // --- Assembly ---

  /**
   * Plain default assembly name for a species (GRCh38, not the patch-level
   * GRCh38.p14), matching the per-feature `assembly_name` overlap rows carry.
   */
  async getDefaultAssemblyName(species: string, ctx: Context): Promise<string> {
    const cached = this.defaultAssemblies.get(species);
    if (cached) return cached;
    const raw = await this.fetchWithRetry<RawAssemblyInfo>(
      `/info/assembly/${encodeURIComponent(species)}`,
      ctx,
    );
    const name = raw.default_coord_system_version;
    if (!name) {
      throw serviceUnavailable('Ensembl assembly info carried no default_coord_system_version.', {
        species,
      });
    }
    this.defaultAssemblies.set(species, name);
    return name;
  }

  // --- VEP ---

  async predictVariantHgvs(notation: string, species: string, ctx: Context): Promise<VepRecord[]> {
    const path = `/vep/${encodeURIComponent(species)}/hgvs/${encodeURIComponent(notation)}?hgvs=1&canonical=1&mane=1`;
    const raw = await this.fetchWithRetry<RawVepRecord[]>(path, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeVep);
  }

  async predictVariantRegion(
    chr: string,
    start: number,
    end: number,
    strand: number,
    allele: string,
    species: string,
    ctx: Context,
  ): Promise<VepRecord[]> {
    const regionAllele = `${encodeURIComponent(`${chr}:${start}:${end}:${strand}`)}/${encodeURIComponent(allele)}`;
    const path = `/vep/${encodeURIComponent(species)}/region/${regionAllele}?hgvs=1&canonical=1&mane=1`;
    const raw = await this.fetchWithRetry<RawVepRecord[]>(path, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeVep);
  }

  async predictVariantId(id: string, species: string, ctx: Context): Promise<VepRecord[]> {
    const path = `/vep/${encodeURIComponent(species)}/id/${encodeURIComponent(id)}?hgvs=1&canonical=1&mane=1`;
    const raw = await this.fetchWithRetry<RawVepRecord[]>(path, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeVep);
  }

  // --- Homology ---

  /**
   * Best-effort names for returned homologs, sharing five seconds across all
   * <=1,000-ID chunks and bounded by the original call's remaining deadline.
   * Primary rows never depend on this lookup; only caller cancellation escapes.
   */
  async getHomologyTargetSymbols(ids: string[], ctx: Context): Promise<Map<string, string>> {
    ctx.signal.throwIfAborted();
    const names = new Map<string, string>();
    const distinct = [...new Set(ids)];
    if (!distinct.length) return names;
    const callStart = this.callStarts.get(ctx) ?? Date.now();
    const budget = Math.min(5000, callStart + ENSEMBL_CALL_DEADLINE_MS - Date.now());
    if (budget <= 0) return names;
    try {
      await withRetry(
        async (attempt) => {
          for (let offset = 0; offset < distinct.length; offset += 1000) {
            attempt.signal.throwIfAborted();
            const chunk = distinct.slice(offset, offset + 1000);
            const raw = await this.fetchJson<Record<string, RawGeneRecord | null>>(
              '/lookup/id',
              ctx,
              { method: 'POST', body: { ids: chunk } },
              attempt,
            );
            attempt.signal.throwIfAborted();
            for (const id of chunk) {
              const record = Object.hasOwn(raw, id) ? raw[id] : null;
              if (typeof record?.display_name === 'string' && record.display_name) {
                names.set(id, record.display_name);
              }
            }
          }
        },
        {
          operation: 'Ensembl homology symbol enrichment',
          signal: ctx.signal,
          deadlineMs: budget,
          maxRetries: 0,
        },
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.debug('Homology symbol lookup incomplete', {
        resolved: names.size,
        requested: distinct.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return names;
  }

  /**
   * The species in Ensembl's pan-taxonomic comparison, read once per process. Concurrent
   * calls share one read and each waits only within its own cancellation and call deadline;
   * the read is aborted once no call waits on it. A failed or empty read is never kept.
   */
  async getPanHomologySpecies(ctx: Context): Promise<ReadonlySet<string>> {
    if (this.panHomologySpecies) return this.panHomologySpecies;
    this.panHomologyLoad ??= this.readPanHomologySpecies(ctx);
    const load = this.panHomologyLoad;
    load.waiters++;
    const callStart = this.callStarts.get(ctx) ?? Date.now();
    this.callStarts.set(ctx, callStart);
    try {
      return await awaitShared(
        load.species,
        ctx.signal,
        callStart + ENSEMBL_CALL_DEADLINE_MS - Date.now(),
      );
    } finally {
      if (--load.waiters === 0) {
        if (this.panHomologyLoad === load) this.panHomologyLoad = undefined;
        load.stop.abort();
      }
    }
  }

  private readPanHomologySpecies(ctx: Context): PanHomologyLoad {
    const stop = new AbortController();
    const species = withRetry(
      (attempt) =>
        this.fetchJson<RawSpeciesSet[]>(PAN_HOMOLOGY_SPECIES_PATH, ctx, undefined, attempt),
      {
        operation: 'Ensembl pan-taxonomic species read',
        baseDelayMs: 1000,
        signal: stop.signal,
        deadlineMs: ENSEMBL_CALL_DEADLINE_MS,
      },
    )
      .then((raw) => {
        const members = new Set<string>();
        for (const set of Array.isArray(raw) ? raw : []) {
          for (const name of set?.species_set ?? []) {
            if (typeof name === 'string') members.add(name.toLowerCase());
          }
        }
        if (members.size === 0) {
          throw serviceUnavailable("Ensembl's pan-taxonomic species set listed no species.");
        }
        this.panHomologySpecies = members;
        return members;
      })
      .finally(() => {
        if (this.panHomologyLoad === load) this.panHomologyLoad = undefined;
      });
    const load: PanHomologyLoad = { species, stop, waiters: 0 };
    return load;
  }

  /**
   * One homology request (`path` ends in its query string). A `target_species` outside the
   * comparison Ensembl runs for the source species answers a GenomeDB miss; when Ensembl's
   * pan-taxonomic comparison holds both species, the request is repeated there. Membership is
   * checked first because Ensembl crashes, rather than rejects, a pan request from a source
   * outside it. A pair it cannot try fails as `target_not_compared`.
   */
  private async requestHomology(
    path: string,
    species: string,
    targetSpecies: string | undefined,
    ctx: Context,
  ): Promise<{ raw: RawHomologyResponse; comparison?: 'pan_homology' }> {
    const query = targetSpecies
      ? `${path}&target_species=${encodeURIComponent(targetSpecies)}`
      : path;
    try {
      return { raw: await this.fetchWithRetry<RawHomologyResponse>(query, ctx) };
    } catch (err) {
      if (!targetSpecies || !(err instanceof McpError) || !err.message.startsWith(GENOMEDB_MISS)) {
        throw err;
      }
      const outsideDefault = `${targetSpecies} is outside the homology comparison Ensembl runs for ${species}, and`;
      let members: ReadonlySet<string>;
      try {
        members = await this.getPanHomologySpecies(ctx);
      } catch (readErr) {
        if (ctx.signal.aborted) throw readErr;
        ctx.log.warning('Pan-taxonomic species read failed', {
          error: readErr instanceof Error ? readErr.message : String(readErr),
        });
        throw validationError(
          `${outsideDefault} the species list of Ensembl's pan-taxonomic comparison could not be read, so the pair was not tried there; retrying later may answer it.`,
          { reason: 'target_not_compared' },
          { cause: readErr },
        );
      }
      const outside = [species, targetSpecies].filter((name) => !members.has(name.toLowerCase()));
      if (outside.length > 0) {
        const viaOrtholog = outside.includes(species)
          ? ` To reach ${targetSpecies}, omit target_species to find this gene's ortholog in a species that comparison holds (caenorhabditis_elegans for a Caenorhabditis gene), then query from that ortholog.`
          : '';
        throw validationError(
          `${outsideDefault} Ensembl's pan-taxonomic comparison does not list ${outside.join(' or ')} among its species, which it names in Ensembl's internal form (homo_sapiens).${viaOrtholog}`,
          { reason: 'target_not_compared' },
        );
      }
      return {
        raw: await this.fetchWithRetry<RawHomologyResponse>(`${query}&compara=pan_homology`, ctx),
        comparison: 'pan_homology',
      };
    }
  }

  async getHomologyBySymbol(
    symbol: string,
    species: string,
    type: string,
    targetSpecies: string | undefined,
    ctx: Context,
  ): Promise<HomologyResult> {
    const { raw, comparison } = await this.requestHomology(
      `/homology/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?type=${encodeURIComponent(type)}`,
      species,
      targetSpecies,
      ctx,
    );
    return { ...normalizeHomology(raw, symbol), ...(comparison && { comparison }) };
  }

  async getHomologyById(
    id: string,
    species: string,
    type: string,
    targetSpecies: string | undefined,
    ctx: Context,
  ): Promise<HomologyResult> {
    const queryId = unversioned(id);
    const { raw, comparison } = await this.requestHomology(
      `/homology/id/${encodeURIComponent(species)}/${encodeURIComponent(queryId)}?type=${encodeURIComponent(type)}`,
      species,
      targetSpecies,
      ctx,
    );
    // An ID absent from the source species answers HTTP 200 {"data":[]}; a known gene
    // with no homologs still carries its own entry with an empty homologies list. The
    // pan-taxonomic comparison answers {"data":[]} for a gene outside its trees; the GenomeDB
    // miss before it already showed the gene is in the source species.
    if (!raw.data?.length && !comparison) {
      throw notFound(`Gene ID "${id}" not found in ${species}.`, { reason: 'not_found' });
    }
    return { ...normalizeHomology(raw, queryId), ...(comparison && { comparison }) };
  }

  // --- Xrefs ---

  async getXrefsById(
    id: string,
    dbname: string | undefined,
    ctx: Context,
    allLevels = false,
  ): Promise<XrefEntry[]> {
    let path = `/xrefs/id/${encodeURIComponent(unversioned(id))}`;
    const params = new URLSearchParams();
    if (dbname) params.set('external_db', dbname);
    if (allLevels) params.set('all_levels', '1');
    if (params.size) path += `?${params}`;
    const raw = await this.fetchWithRetry<RawXrefEntry[]>(path, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeXref);
  }

  // --- Species ---

  async listSpecies(division: string | undefined, ctx: Context): Promise<SpeciesInfo[]> {
    let path = '/info/species';
    if (division) path += `?division=${encodeURIComponent(division)}`;
    const raw = await this.fetchWithRetry<RawSpeciesResponse>(path, ctx);
    return normalizeSpecies(raw);
  }
}

// --- Init/accessor pattern ---

let _service: EnsemblService | undefined;

export function initEnsemblService(config: AppConfig, storage: StorageService): void {
  _service = new EnsemblService(config, storage);
}

export function getEnsemblService(): EnsemblService {
  if (!_service) {
    throw new Error('EnsemblService not initialized — call initEnsemblService() in setup()');
  }
  return _service;
}
