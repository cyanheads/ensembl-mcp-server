/**
 * @fileoverview Bundle agent-doc selector: `scripts/clean-mcpb.ts` strips, and
 * `scripts/lint-packaging.ts` check 8 rejects, agent-doc trees at a dependency's
 * package root while the MCP SDK's runtime `dist/ext/skills/` modules ship.
 * @module tests/scripts/mcpb-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/** The `scripts/lint-packaging.ts` exports this suite reads. */
interface LintPackaging {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: the script's repo-only fallback import
 * (`../src/mcp-server/skills.js`) fails `tsc` once a static import pulls it into
 * the program (mcp-ts-core#797).
 */
const lintPackaging: LintPackaging = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/node_modules/other-pkg/lib/skills/loader.js',
  'node_modules/skills/index.js',
  'node_modules/@acme/skills/index.js',
  'node_modules/@acme/framework-skills/index.js',
  'skills/ensembl-guide/SKILL.md',
  'dist/index.js',
];

const agentDocEntries = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/some-pkg/skills/guide/references/notes.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/x/notes.md',
  'node_modules/a/node_modules/@scope/b/skills/x/README.md',
  'node_modules/a/node_modules/b/.claude/commands/run.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('bundle agent-doc selector', () => {
  it.each(runtimeEntries)('keeps %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintPackaging.AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });

  it.each(agentDocEntries)('strips %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(lintPackaging.AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });

  it('uses one literal in the cleaner and the packaging check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('passes a cleaned listing through check 8 and fails one holding agent docs', () => {
    expect(lintPackaging.checkBundleEntries(runtimeEntries, 'dist/test.mcpb')).toEqual([]);
    const errors = lintPackaging.checkBundleEntries(
      [...runtimeEntries, ...agentDocEntries],
      'dist/test.mcpb',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${agentDocEntries.length} node_modules agent-doc entries`);
  });
});
