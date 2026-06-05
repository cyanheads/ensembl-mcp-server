/**
 * @fileoverview Ensembl REST API response types confirmed against live API payloads.
 * @module services/ensembl/types
 */

// --- Raw upstream types (fields optional unless guaranteed present) ---

export type RawGeneRecord = {
  id: string;
  display_name?: string;
  description?: string;
  biotype?: string;
  species?: string;
  seq_region_name?: string;
  start?: number;
  end?: number;
  strand?: number;
  assembly_name?: string;
  Transcript?: RawTranscriptSummary[];
  is_canonical?: number;
  version?: number;
  object_type?: string;
  logic_name?: string;
  db_type?: string;
  source?: string;
};

export type RawTranscriptSummary = {
  id: string;
  display_name?: string;
  biotype?: string;
  is_canonical?: number;
  start?: number;
  end?: number;
  strand?: number;
  length?: number;
  Parent?: string;
  object_type?: string;
};

export type RawTranscriptRecord = {
  id: string;
  display_name?: string;
  biotype?: string;
  is_canonical?: number;
  start?: number;
  end?: number;
  strand?: number;
  length?: number;
  Parent?: string;
  species?: string;
  seq_region_name?: string;
  assembly_name?: string;
  Exon?: Array<{ id: string; start: number; end: number; strand: number }>;
  object_type?: string;
  db_type?: string;
  source?: string;
  version?: number;
};

export type RawSequenceRecord = {
  id: string;
  seq: string;
  molecule?: string;
  desc?: string;
  version?: number;
  query?: string;
};

export type RawOverlapFeature = {
  id?: string;
  external_name?: string;
  biotype?: string;
  feature_type?: string;
  seq_region_name?: string;
  start?: number;
  end?: number;
  strand?: number;
  assembly_name?: string;
  description?: string;
  consequence_type?: string;
  clinical_significance?: string[];
  alleles?: string[];
  source?: string;
};

export type RawVepTranscriptConsequence = {
  transcript_id?: string;
  gene_id?: string;
  gene_symbol?: string;
  consequence_terms?: string[];
  impact?: string;
  biotype?: string;
  strand?: number;
  amino_acids?: string;
  codons?: string;
  hgvsc?: string;
  hgvsp?: string;
  protein_id?: string;
  sift?: { prediction: string; score: number };
  polyphen?: { prediction: string; score: number };
};

export type RawColocatedVariant = {
  id?: string;
  allele_string?: string;
  clinical_significance?: string[];
  frequencies?: Record<string, unknown>;
  pubmed?: number[];
  somatic?: number;
};

export type RawVepRecord = {
  input?: string;
  allele_string?: string;
  start?: number;
  end?: number;
  strand?: number;
  seq_region_name?: string;
  assembly_name?: string;
  most_severe_consequence?: string;
  transcript_consequences?: RawVepTranscriptConsequence[];
  colocated_variants?: RawColocatedVariant[];
};

export type RawHomologyEntry = {
  id: string;
  species?: string;
  type?: string;
  perc_id?: number;
  perc_pos?: number;
  taxonomy_level?: string;
  target?: {
    id?: string;
    species?: string;
    perc_id?: number;
    perc_pos?: number;
  };
};

export type RawHomologyResponse = {
  data?: Array<{
    id: string;
    homologies?: RawHomologyEntry[];
  }>;
};

export type RawXrefEntry = {
  dbname?: string;
  db_display_name?: string;
  primary_id?: string;
  display_id?: string;
  description?: string;
  info_type?: string;
  synonyms?: string[];
  version?: string;
};

export type RawSpeciesInfo = {
  name?: string;
  display_name?: string;
  common_name?: string;
  taxon_id?: string;
  assembly?: string;
  division?: string;
  groups?: string[];
  aliases?: string[];
  accession?: string;
  strain?: string;
};

export type RawSpeciesResponse = {
  species?: RawSpeciesInfo[];
};

// --- Ensembl API error envelope ---

export type EnsemblErrorEnvelope = {
  error: string;
};

// --- Normalized domain types ---

export type GeneRecord = {
  id: string;
  species?: string;
  displayName?: string;
  description?: string;
  biotype?: string;
  chromosome?: string;
  start?: number;
  end?: number;
  strand?: number;
  assemblyName?: string;
  transcripts?: TranscriptSummary[];
};

export type TranscriptSummary = {
  id: string;
  displayName?: string;
  biotype?: string;
  isCanonical: boolean;
  start?: number;
  end?: number;
  strand?: number;
  lengthInBp?: number;
};

export type TranscriptRecord = {
  id: string;
  parentGeneId?: string;
  displayName?: string;
  biotype?: string;
  isCanonical: boolean;
  species?: string;
  chromosome?: string;
  start?: number;
  end?: number;
  strand?: number;
  assemblyName?: string;
  lengthInBp?: number;
};

export type SequenceRecord = {
  id: string;
  type: string;
  seq: string;
  lengthInBp: number;
  description?: string;
};

export type OverlapFeature = {
  id?: string;
  name?: string;
  featureType: string;
  biotype?: string;
  chromosome: string;
  start: number;
  end: number;
  strand?: number;
  description?: string;
  consequenceType?: string;
  clinicalSignificance?: string[];
};

export type VepConsequence = {
  transcriptId?: string;
  geneId?: string;
  geneSymbol?: string;
  consequenceTerms: string[];
  impact?: string;
  biotype?: string;
  hgvsc?: string;
  hgvsp?: string;
  aminoAcids?: string;
  sift?: { prediction: string; score: number };
  polyphen?: { prediction: string; score: number };
};

export type ColocatedVariant = {
  id?: string;
  alleleString?: string;
  clinicalSignificance?: string[];
  pubmed?: number[];
};

export type VepRecord = {
  input?: string;
  chromosome?: string;
  start?: number;
  end?: number;
  assemblyName?: string;
  mostSevereConsequence?: string;
  transcriptConsequences: VepConsequence[];
  colocatedVariants: ColocatedVariant[];
};

export type HomologyEntry = {
  targetId: string;
  targetSpecies?: string;
  type?: string;
  percId?: number;
  percPos?: number;
  taxonomyLevel?: string;
};

export type XrefEntry = {
  dbname?: string;
  dbDisplayName?: string;
  primaryId?: string;
  displayId?: string;
  description?: string;
};

export type SpeciesInfo = {
  name: string;
  displayName?: string;
  commonName?: string;
  taxonId?: string;
  assembly?: string;
  division?: string;
};
