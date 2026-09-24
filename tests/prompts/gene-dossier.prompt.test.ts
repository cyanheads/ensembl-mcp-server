/**
 * @fileoverview Tests for the ensembl_gene_dossier prompt.
 * @module tests/prompts/gene-dossier.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { ensemblGeneDossierPrompt } from '@/mcp-server/prompts/definitions/gene-dossier.prompt.js';

describe('ensemblGeneDossierPrompt', () => {
  it('generates valid messages for gene_symbol + species args', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({
      gene_symbol: 'BRCA2',
      species: 'homo_sapiens',
    });
    const messages = await ensemblGeneDossierPrompt.generate(args);
    expect(messages).toBeInstanceOf(Array);
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  it('interpolates gene_symbol and species into the message text', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({
      gene_symbol: 'TP53',
      species: 'mus_musculus',
    });
    const messages = await ensemblGeneDossierPrompt.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;
    expect(text).toContain('TP53');
    expect(text).toContain('mus_musculus');
  });

  it('defaults species to homo_sapiens', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'EGFR' });
    expect(args.species).toBe('homo_sapiens');
    const messages = await ensemblGeneDossierPrompt.generate(args);
    const text = (messages[0]!.content as { type: string; text: string }).text;
    expect(text).toContain('homo_sapiens');
    expect(text).toContain('EGFR');
  });

  it('includes all 7 workflow steps in the prompt text', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const messages = await ensemblGeneDossierPrompt.generate(args);
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

  it('sources functional impact from VEP, not query_region, and offers rsID input (issue #7)', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const text = (
      (await ensemblGeneDossierPrompt.generate(args))[0]!.content as {
        type: string;
        text: string;
      }
    ).text;
    // Step 3 must not claim ensembl_query_region can identify functional impact before VEP.
    expect(text).not.toContain('Identify any HIGH or MODERATE impact');
    expect(text).toContain('comes from VEP');
    // Step 4's rsID example is valid now that ensembl_predict_variant accepts rsIDs (#11).
    expect(text).toContain('rsID');
    expect(text).toContain('rs334');
  });

  it('step 3 reflects the ensembl_query_region cap and how to reach the rest (issue #17)', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const text = (
      (await ensemblGeneDossierPrompt.generate(args))[0]!.content as {
        type: string;
        text: string;
      }
    ).text;
    const step3 = text.slice(text.indexOf('3. **'), text.indexOf('4. **'));
    expect(step3).toContain('feature=["variation"]');
    // The variant count is the uncapped totalCount, not the length of the returned page.
    expect(step3).toContain('totalCount');
    expect(step3).toContain('max_results');
    expect(step3).toContain('narrower');
    // The synthesis step reports that same count.
    expect(text.slice(text.indexOf('7. **'))).toContain('totalCount');
  });

  it('message role is "user"', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const messages = await ensemblGeneDossierPrompt.generate(args);
    expect(messages[0]!.role).toBe('user');
  });

  it('message content type is "text"', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'BRCA2' });
    const messages = await ensemblGeneDossierPrompt.generate(args);
    expect((messages[0]!.content as { type: string }).type).toBe('text');
  });
});
