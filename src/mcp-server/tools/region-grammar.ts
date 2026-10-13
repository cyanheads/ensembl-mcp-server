/**
 * @fileoverview The genomic region grammar shared by ensembl_get_sequence and
 * ensembl_query_region — `[species:]chr:start(-|..)end[:strand]` — with the checks
 * both tools run before a request: coordinate order, and the `M`/`chrM` spellings of
 * the mitochondrion, which Ensembl resolves correctly in some species only.
 * @module mcp-server/tools/region-grammar
 */

/**
 * Species `[a-z0-9_]+` and chromosome `[\w.]+` (both case-insensitive), digit-string
 * coordinates, strand `1` or `-1`. A chromosome holds no `-` or `:` and a strand is
 * never a range, so at most one reading of the optional species group matches: the
 * parse, not a colon count, decides bare vs. prefixed. Anchored, with each quantified
 * class bounded by a delimiter it cannot match, so matching is linear in the input.
 */
const REGION = /^(?:([a-z0-9_]+):)?(([\w.]+):(\d+)(?:-|\.\.)(\d+)(?::-?1)?)$/i;

/**
 * `M` and `chrM` in any case, which Ensembl resolves per species and spelling: the
 * mitochondrion in Drosophila, an unrelated scaffold in human and mouse, an unrelated
 * contig in C. elegans, nothing in zebrafish. EnsemblService.checkMitochondrionAlias asks.
 */
const MITOCHONDRION_ALIAS = /^(?:chr)?m$/i;

/** A region the grammar accepts. */
export interface ParsedRegion {
  /** Chromosome or sequence region name as written. */
  chromosome: string;
  /** End coordinate with leading zeros stripped. */
  end: string;
  /** Everything after any species prefix, exactly as written — what Ensembl receives. */
  region: string;
  /** Species prefix as written, when the text carries one. */
  species?: string;
  /** Start coordinate with leading zeros stripped. */
  start: string;
}

const stripLeadingZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '');

/** Parses `[species:]chr:start(-|..)end[:strand]`; `undefined` when the text is not that form. */
export function parseRegion(text: string): ParsedRegion | undefined {
  const match = REGION.exec(text);
  if (!match) return;
  const [, species, region = '', chromosome = '', start = '', end = ''] = match;
  return {
    chromosome,
    region,
    start: stripLeadingZeros(start),
    end: stripLeadingZeros(end),
    ...(species && { species }),
  };
}

/**
 * True when start is past end. Compares the digit strings (length, then lexically),
 * which stays exact past double precision and linear in the input where BigInt
 * parsing is not.
 */
export function isReversed({ start, end }: ParsedRegion): boolean {
  return start.length > end.length || (start.length === end.length && start > end);
}

/** Rejection text for a region whose start is past its end. */
export function reversedMessage(text: string, { start, end }: ParsedRegion): string {
  return `Region ${text} is reversed: start ${start} is greater than its end ${end}.`;
}

/**
 * Linear-time `/first.*second/i`: `first`, then `second` later on the same line.
 * Ensembl echoes the caller's ID or region into its error text, and the backtracking
 * regex is quadratic in that echo.
 */
export function mentionsInOrder(msg: string, first: string, second: string): boolean {
  return msg
    .toLowerCase()
    .split(/[\n\r\u2028\u2029]/)
    .some((line) => {
      const at = line.indexOf(first);
      return at !== -1 && line.includes(second, at + first.length);
    });
}

/** The chromosome a species-less region names: everything before its first colon. */
export function leadingChromosome(region: string): string {
  const colon = region.indexOf(':');
  return colon === -1 ? region : region.slice(0, colon);
}

/** True for `M` and `chrM` in any case, which Ensembl can resolve to the wrong sequence region. */
export function isMitochondrionAlias(chromosome: string): boolean {
  return MITOCHONDRION_ALIAS.test(chromosome);
}

/**
 * Rejection text for a region (no species prefix) whose `M`/`chrM` chromosome Ensembl
 * does not resolve to the species' mitochondrion, naming the mitochondrion when known.
 */
export function mitochondrionMessage(
  region: string,
  chromosome: string,
  species: string,
  mitochondrion: string | undefined,
): string {
  const rename = mitochondrion
    ? `Name it ${mitochondrion} (${mitochondrion}${region.slice(chromosome.length)}).`
    : 'Name the mitochondrion as Ensembl does for the species — MT in vertebrates, MtDNA in ' +
      'C. elegans, Mt in Arabidopsis — or take the chromosome ensembl_lookup_gene reports for ' +
      'a mitochondrially encoded gene.';
  return (
    `Ensembl does not resolve ${chromosome} to the mitochondrion for ${species}: it answers ` +
    `with an unrelated sequence region or none. ${rename}`
  );
}
