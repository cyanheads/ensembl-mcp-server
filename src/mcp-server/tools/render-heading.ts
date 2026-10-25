/**
 * @fileoverview Renders upstream titles without losing line breaks to CommonMark headings.
 * @module mcp-server/tools/render-heading
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Multiline titles use a paragraph because ATX headings cannot contain hard breaks. */
export function renderHeading(level: 2 | 3 | 4, title: string): string {
  const text = escapeMarkdownInline(title);
  if (/[\r\n]/.test(title)) return `**${text}**`;
  // ATX headings consume a final hash run preceded by whitespace as a closing marker.
  return `${'#'.repeat(level)} ${text.replace(/(?<=[ \t])#+$/, '\\$&')}`;
}
