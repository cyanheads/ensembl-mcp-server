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

  it('step 1 continues from an ambiguous lookup by candidate id (issue #20)', async () => {
    const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'MDR1' });
    const text = (
      (await ensemblGeneDossierPrompt.generate(args))[0]!.content as {
        type: string;
        text: string;
      }
    ).text;
    const step1 = text.slice(text.indexOf('1. **'), text.indexOf('2. **'));
    expect(step1).toContain('ambiguous');
    expect(step1).toContain('matchedAlias');
    expect(step1).toContain('again with its id');
    expect(step1).toContain('use that stable ID wherever a later step names the symbol');
  });

  describe('steps 5-7 call shapes (issues #53, #54)', () => {
    const generateText = async (species?: string) => {
      const args = ensemblGeneDossierPrompt.args!.parse({ gene_symbol: 'TP53', species });
      const messages = await ensemblGeneDossierPrompt.generate(args);
      return (messages[0]!.content as { type: string; text: string }).text;
    };
    const step = (text: string, n: number) =>
      text.slice(text.indexOf(`${n}. **`), text.indexOf(`${n + 1}. **`));

    it.each([
      ['homo_sapiens', '"mus_musculus", "rattus_norvegicus", "danio_rerio"'],
      ['mus_musculus', '"homo_sapiens", "rattus_norvegicus", "danio_rerio"'],
      ['rattus_norvegicus', '"mus_musculus", "homo_sapiens", "danio_rerio"'],
      ['danio_rerio', '"mus_musculus", "rattus_norvegicus", "homo_sapiens"'],
      ['drosophila_melanogaster', '"mus_musculus", "rattus_norvegicus", "danio_rerio"'],
    ])('step 5 queries one target_species per model organism from %s', async (species, targets) => {
      const step5 = step(await generateText(species), 5);
      expect(step5).toContain(
        `species="${species}", type="orthologues", and target_species set to each of ${targets} in turn.`,
      );
    });

    it('step 5 reports every co-ortholog row instead of a top 3', async () => {
      const step5 = step(await generateText(), 5);
      expect(step5).not.toContain('top 3');
      expect(step5).toContain(
        'When type is ortholog_one2many or ortholog_many2many, the gene has several orthologs in that species: report every row for it',
      );
      expect(step5).toContain('repeat that call with max_results=0');
    });

    it('step 6 reads gene-level IDs from the gene and Swiss-Prot from the canonical transcript', async () => {
      const step6 = step(await generateText(), 6);
      const bullets = step6.split('\n').filter((line) => line.startsWith('   - '));
      expect(bullets).toHaveLength(2);
      const [geneCall, transcriptCall] = bullets as [string, string];

      expect(geneCall).toContain(
        'The stable gene ID from step 1, with no dbname and all_levels left false.',
      );
      expect(geneCall).not.toContain('all_levels=true');
      for (const db of ['dbname=HGNC', 'dbname=EntrezGene', 'dbname=MIM_GENE']) {
        expect(geneCall).toContain(db);
      }

      expect(transcriptCall).toContain(
        'The canonical transcript ID from step 1, with all_levels=true and dbname="Uniprot/SWISSPROT".',
      );
      expect(transcriptCall).toContain('An empty result means no reviewed UniProt entry is linked');

      // The gene-name tag lists unreviewed accessions; RefSeq rides step 1, GO is not requested.
      expect(step6).not.toContain('Uniprot_gn');
      expect(step6).toContain("RefSeq transcript from step 1's maneSelect");
      expect(step6).not.toContain('RefSeq_');
      expect(step6).not.toMatch(/\bGO\b/);
    });

    it('step 7 chains each ID to a source that serves it', async () => {
      const text = await generateText();
      const step7 = text.slice(text.indexOf('7. **'));
      expect(step7).toContain(
        'UniProt accession → UniProt for function and PubChem for bioassays; gene symbol → PubMed search for literature; MIM_GENE → OMIM for disease\n',
      );
      expect(step7).not.toContain('pubchem for structure');
    });

    it('the description promises no literature follow-up from xref IDs', () => {
      expect(ensemblGeneDossierPrompt.description).not.toContain('literature');
      expect(ensemblGeneDossierPrompt.description).toContain(
        'model-organism orthologs → external database IDs for protein and disease follow-up.',
      );
    });
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
