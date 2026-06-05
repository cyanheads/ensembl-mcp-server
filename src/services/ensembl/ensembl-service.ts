/**
 * @fileoverview Ensembl REST API service — HTTP client, rate-limit-aware retry,
 * error normalization, and typed methods per endpoint family.
 * @module services/ensembl/ensembl-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  EnsemblErrorEnvelope,
  GeneRecord,
  HomologyEntry,
  OverlapFeature,
  RawGeneRecord,
  RawHomologyResponse,
  RawOverlapFeature,
  RawSequenceRecord,
  RawSpeciesResponse,
  RawTranscriptRecord,
  RawVepRecord,
  RawXrefEntry,
  SequenceRecord,
  SpeciesInfo,
  TranscriptRecord,
  VepRecord,
  XrefEntry,
} from './types.js';

// --- Normalizers ---

function normalizeGene(raw: RawGeneRecord): GeneRecord {
  const desc = raw.description?.split('[')[0]?.trim();
  return {
    id: raw.id,
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
      transcripts: raw.Transcript.map((t) => ({
        id: t.id,
        ...(t.display_name && { displayName: t.display_name }),
        ...(t.biotype && { biotype: t.biotype }),
        isCanonical: t.is_canonical === 1,
        ...(typeof t.start === 'number' && { start: t.start }),
        ...(typeof t.end === 'number' && { end: t.end }),
        ...(typeof t.strand === 'number' && { strand: t.strand }),
        ...(typeof t.length === 'number' && { lengthInBp: t.length }),
      })),
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
    lengthInBp: raw.seq.length,
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
    ...(raw.description && { description: raw.description }),
    ...(raw.consequence_type && { consequenceType: raw.consequence_type }),
    ...(raw.clinical_significance?.length && {
      clinicalSignificance: raw.clinical_significance,
    }),
  };
}

function normalizeVep(raw: RawVepRecord): VepRecord {
  return {
    ...(raw.input && { input: raw.input }),
    ...(raw.seq_region_name && { chromosome: raw.seq_region_name }),
    ...(typeof raw.start === 'number' && { start: raw.start }),
    ...(typeof raw.end === 'number' && { end: raw.end }),
    ...(raw.assembly_name && { assemblyName: raw.assembly_name }),
    ...(raw.most_severe_consequence && {
      mostSevereConsequence: raw.most_severe_consequence,
    }),
    transcriptConsequences: (raw.transcript_consequences ?? []).map((tc) => ({
      ...(tc.transcript_id && { transcriptId: tc.transcript_id }),
      ...(tc.gene_id && { geneId: tc.gene_id }),
      ...(tc.gene_symbol && { geneSymbol: tc.gene_symbol }),
      consequenceTerms: tc.consequence_terms ?? [],
      ...(tc.impact && { impact: tc.impact }),
      ...(tc.biotype && { biotype: tc.biotype }),
      ...(tc.hgvsc && { hgvsc: tc.hgvsc }),
      ...(tc.hgvsp && { hgvsp: tc.hgvsp }),
      ...(tc.amino_acids && { aminoAcids: tc.amino_acids }),
      ...(tc.sift && { sift: tc.sift }),
      ...(tc.polyphen && { polyphen: tc.polyphen }),
    })),
    colocatedVariants: (raw.colocated_variants ?? []).map((cv) => ({
      ...(cv.id && { id: cv.id }),
      ...(cv.allele_string && { alleleString: cv.allele_string }),
      ...(cv.clinical_significance?.length && {
        clinicalSignificance: cv.clinical_significance,
      }),
      ...(cv.pubmed?.length && { pubmed: cv.pubmed }),
    })),
  };
}

function normalizeHomology(raw: RawHomologyResponse, sourceId: string): HomologyEntry[] {
  const dataEntry = raw.data?.find((d) => d.id === sourceId) ?? raw.data?.[0];
  if (!dataEntry?.homologies) return [];
  return dataEntry.homologies.map((h) => ({
    targetId: h.target?.id ?? h.id,
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
}

function normalizeXref(raw: RawXrefEntry): XrefEntry {
  return {
    ...(raw.dbname && { dbname: raw.dbname }),
    ...(raw.db_display_name && { dbDisplayName: raw.db_display_name }),
    ...(raw.primary_id && { primaryId: raw.primary_id }),
    ...(raw.display_id && { displayId: raw.display_id }),
    ...(raw.description && { description: raw.description }),
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

export class EnsemblService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().baseUrl;
  }

  // --- Core fetch ---

  private async fetchJson<T>(
    path: string,
    ctx: Context,
    options?: {
      method?: 'GET' | 'POST';
      body?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options?.method ?? 'GET';
    const fetchOptions: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: options?.signal ?? ctx.signal,
    };
    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    ctx.log.debug('Ensembl request', { url, method });

    const response = await fetch(url, fetchOptions);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw serviceUnavailable(
        `Ensembl rate limit exceeded.${retryAfter ? ` Retry after ${retryAfter}s.` : ''}`,
        { retryAfter: retryAfter ? Number(retryAfter) : undefined },
      );
    }

    const text = await response.text();

    // Detect HTML error pages
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'Ensembl API returned HTML instead of JSON — service may be degraded.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw serviceUnavailable(`Ensembl API returned unparseable response.`, {
        status: response.status,
      });
    }

    // Ensembl error envelope: { error: "..." }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as EnsemblErrorEnvelope).error === 'string'
    ) {
      const msg = (parsed as EnsemblErrorEnvelope).error;
      // Classify based on message content
      if (/not found|not exist|does not exist|no stable id/i.test(msg)) {
        throw notFound(msg);
      }
      if (/invalid|unrecognized|malformed|bad request/i.test(msg)) {
        throw validationError(msg);
      }
      // Generic API error — treat as not found for ID-based lookups
      throw notFound(msg);
    }

    if (!response.ok) {
      throw serviceUnavailable(`Ensembl API returned HTTP ${response.status}.`, {
        status: response.status,
        url,
      });
    }

    return parsed as T;
  }

  // --- withRetry wrapper ---

  private fetchWithRetry<T>(
    path: string,
    ctx: Context,
    options?: {
      method?: 'GET' | 'POST';
      body?: unknown;
    },
  ): Promise<T> {
    const operation = `EnsemblService.fetch:${path.split('?')[0]}`;
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId },
    });
    return withRetry(() => this.fetchJson<T>(path, ctx, options), {
      operation,
      context: reqCtx,
      baseDelayMs: 1000,
      signal: ctx.signal,
    });
  }

  // --- Gene lookup ---

  async lookupGene(
    symbol: string,
    species: string,
    expandTranscripts: boolean,
    ctx: Context,
  ): Promise<GeneRecord> {
    const expand = expandTranscripts ? '?expand=1' : '';
    const path = `/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}${expand}`;
    const raw = await this.fetchWithRetry<RawGeneRecord>(path, ctx);
    return normalizeGene(raw);
  }

  async lookupGeneById(id: string, expandTranscripts: boolean, ctx: Context): Promise<GeneRecord> {
    const expand = expandTranscripts ? '?expand=1' : '';
    const path = `/lookup/id/${encodeURIComponent(id)}${expand}`;
    const raw = await this.fetchWithRetry<RawGeneRecord>(path, ctx);
    return normalizeGene(raw);
  }

  async lookupGenesBatch(
    ids: string[],
    expandTranscripts: boolean,
    ctx: Context,
  ): Promise<Map<string, GeneRecord>> {
    const body: Record<string, unknown> = { ids };
    if (expandTranscripts) body.expand = 1;
    const raw = await this.fetchWithRetry<Record<string, RawGeneRecord | null>>('/lookup/id', ctx, {
      method: 'POST',
      body,
    });
    const result = new Map<string, GeneRecord>();
    for (const [k, v] of Object.entries(raw)) {
      if (v) result.set(k, normalizeGene(v));
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
      `/lookup/symbol/${encodeURIComponent(species)}`,
      ctx,
      { method: 'POST', body },
    );
    const result = new Map<string, GeneRecord>();
    for (const [k, v] of Object.entries(raw)) {
      if (v) result.set(k, normalizeGene(v));
    }
    return result;
  }

  // --- Transcript lookup ---

  async lookupTranscript(id: string, ctx: Context): Promise<TranscriptRecord> {
    const path = `/lookup/id/${encodeURIComponent(id)}`;
    const raw = await this.fetchWithRetry<RawTranscriptRecord>(path, ctx);
    return normalizeTranscript(raw);
  }

  // --- Sequence ---

  async getSequenceById(id: string, type: string, ctx: Context): Promise<SequenceRecord> {
    const path = `/sequence/id/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`;
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

  // --- VEP ---

  async predictVariantHgvs(notation: string, species: string, ctx: Context): Promise<VepRecord[]> {
    const path = `/vep/${encodeURIComponent(species)}/hgvs/${encodeURIComponent(notation)}`;
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
    const path = `/vep/${encodeURIComponent(species)}/region/${regionAllele}`;
    const raw = await this.fetchWithRetry<RawVepRecord[]>(path, ctx);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeVep);
  }

  // --- Homology ---

  async getHomologyBySymbol(
    symbol: string,
    species: string,
    type: string,
    targetSpecies: string | undefined,
    ctx: Context,
  ): Promise<HomologyEntry[]> {
    let path = `/homology/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?type=${encodeURIComponent(type)}`;
    if (targetSpecies) path += `&target_species=${encodeURIComponent(targetSpecies)}`;
    const raw = await this.fetchWithRetry<RawHomologyResponse>(path, ctx);
    return normalizeHomology(raw, symbol);
  }

  async getHomologyById(
    id: string,
    species: string,
    type: string,
    targetSpecies: string | undefined,
    ctx: Context,
  ): Promise<HomologyEntry[]> {
    let path = `/homology/id/${encodeURIComponent(species)}/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`;
    if (targetSpecies) path += `&target_species=${encodeURIComponent(targetSpecies)}`;
    const raw = await this.fetchWithRetry<RawHomologyResponse>(path, ctx);
    return normalizeHomology(raw, id);
  }

  // --- Xrefs ---

  async getXrefsById(id: string, dbname: string | undefined, ctx: Context): Promise<XrefEntry[]> {
    let path = `/xrefs/id/${encodeURIComponent(id)}`;
    if (dbname) path += `?external_db=${encodeURIComponent(dbname)}`;
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
