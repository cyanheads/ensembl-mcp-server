/**
 * @fileoverview Tests for the ensembl_gene_dossier prompt.
 * @module tests/prompts/gene-dossier.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { ensemblGeneDossierPrompt } from '@/mcp-server/prompts/definitions/gene-dossier.prompt.js';

describe('ensemblGeneDossierPrompt', () => {
  it('generates valid messages for gene_symbol + species args', () => {
    const args = ensemblGeneDossierPrompt.args!.parse({
      gene_symbol: 'BRCA2',
      species: 'homo_sapiens',
    });
    const messages = ensemblGeneDossierPrompt.generate(args);
    expect(messages).toBeInstanceOf(Array);
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  it('interpolates gene_symbol and species into the message text', () => {
    const args = ensemblGeneDossierPrompt.args!.parse({
      gene_symbol: 'TP53',
      species: 'mus_musculus',
    });
    const messages = ensemblGeneDossierPrompt.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;
    expect(text).toContain('TP53');
    expect(text).toContain('mus_musculus');
  });

  it('defaults species to homo_sapiens', () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'EGFR' });
    expect(args.species).toBe('homo_sapiens');
    const messages = ensemblGeneDossierPrompt.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;
    expect(text).toContain('homo_sapiens');
    expect(text).toContain('EGFR');
  });

  it('includes all 7 workflow steps in the prompt text', () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const messages = ensemblGeneDossierPrompt.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;
    // Steps 1-7 referenced in the prompt
    expect(text).toContain('ensembl_lookup_gene');
    expect(text).toContain('ensembl_get_sequence');
    expect(text).toContain('ensembl_query_region');
    expect(text).toContain('ensembl_predict_variant');
    expect(text).toContain('ensembl_get_homology');
    expect(text).toContain('ensembl_get_xrefs');
    expect(text).toContain('Synthesize');
  });

  it('message role is "user"', () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const messages = ensemblGeneDossierPrompt.generate(args);
    expect(messages[0]!.role).toBe('user');
  });

  it('message content type is "text"', () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const messages = ensemblGeneDossierPrompt.generate(args);
    expect((messages[0]!.content as { type: string }).type).toBe('text');
  });
});
