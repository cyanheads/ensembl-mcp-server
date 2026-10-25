/**
 * @fileoverview Reads literal text from CommonMark response content for parity assertions.
 * @module tests/helpers/read-markdown
 */

import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt('commonmark');

/** Text a CommonMark reader receives, including literal text inside code blocks. */
export function readMarkdownText(markdown: string): string {
  return parser
    .parse(markdown, {})
    .flatMap((token) => {
      if (token.type === 'fence' || token.type === 'code_block') return [token.content];
      return (token.children ?? []).map((child) => {
        if (child.type === 'hardbreak' || child.type === 'softbreak') return '\n';
        return child.type === 'text' || child.type === 'code_inline' ? child.content : '';
      });
    })
    .join('');
}
