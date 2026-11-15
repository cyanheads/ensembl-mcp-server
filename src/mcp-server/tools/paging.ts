/**
 * @fileoverview Offset paging shared by the tools that slice one ordered result set.
 * @module mcp-server/tools/paging
 */

/** One page of an ordered list, and the offset of the page after it (absent on the last page). */
export function pageOf<T>(items: readonly T[], offset: number, limit: number) {
  const page = items.slice(offset, offset + limit);
  const end = offset + page.length;
  return { page, nextOffset: end < items.length ? end : undefined };
}

/** Notice for an offset at or past the end of a non-empty result set; `noun` is the plural item name. */
export function pastEndNotice(noun: string, offset: number, total: number): string {
  return `No ${noun} returned: offset ${offset} is at or past the end of the ${total} matching ${noun}. Request an offset below ${total}, or omit offset for the first page.`;
}
