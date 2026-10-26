import { describe, expect, it } from 'vitest';
import { classifyReason } from '../server/classifier/pipeline.js';
import { classifyRules } from '../server/classifier/rules.js';
import { normalizeReason } from '../server/classifier/normalize.js';
import { pointsFor } from '../server/classifier/taxonomy.js';
import type { CategoryAssessment, CategoryId } from '../server/types.js';

const offline = {
  fuzzyThreshold: 0.82,
  semanticEnabled: false,
  model: null,
  suppressSemanticDisabledReview: true,
} as const;

async function classify(reason: string) {
  return classifyReason(reason, 'present', offline);
}

function ids(categories: CategoryAssessment[]): CategoryId[] {
  return categories.map((category) => category.categoryId).sort();
}

describe('normalisation', () => {
  it('normalises Arabic variants, diacritics and digits without altering the source', () => {
    expect(normalizeReason('  شَحْنَ الحِسَاب  ')).toBe('شحن الحساب');
    expect(normalizeReason('تم شحن ٣٠ دولار')).toBe('تم شحن 30 دولار');
    expect(normalizeReason('Top-Up Completed!')).toBe('top up completed');
  });
});

describe('Recharge classification', () => {
  it.each([
    ['تم شحن الحساب للاعب', 'Arabic'],
    ['شحنت اللعبة للاعب', 'Arabic without final ta-marbuta'],
    ['الشحن تم بنجاح', 'Egyptian Arabic'],
    ['tm el shahn lel 7sab', 'Arabizi'],
    ['shahnet el 7sab', 'Arabizi variant'],
    ['Recharge completed for the player', 'English'],
    ['Player top-up completed', 'English with hyphen'],
    ['recharge', 'bare dashboard code'],
  ])('classifies %s (%s) as Recharge worth 2 points', async (reason) => {
    const result = await classify(reason);
    expect(ids(result.categories)).toContain('RECHARGE');
    const recharge = result.categories.find((category) => category.categoryId === 'RECHARGE');
    expect(recharge?.points).toBe(2);
    expect(result.fallback).toBe(false);
  });

  it('does not treat a question about recharging as a completed recharge', async () => {
    const result = await classify('Player asked how to recharge');
    expect(ids(result.categories)).not.toContain('RECHARGE');
  });

  it('falls back for a foreign staff-application reason instead of awarding a model guess', async () => {
    let calls = 0;
    const result = await classifyReason('تقديم اداره', 'present', {
      ...offline,
      semanticEnabled: true,
      semantic: async () => {
        calls += 1;
        return {
          categories: [{ categoryId: 'RECHARGE', evidence: 'bad model guess', confidence: 'high' }],
          alternatives: [],
          unresolvedPortion: null,
          reviewRequired: false,
          explanation: 'bad model guess',
          model: 'test-model',
          latencyMs: 1,
        };
      },
    });
    expect(calls).toBe(0);
    expect(ids(result.categories)).toEqual(['GENERAL_ISSUE']);
    expect(result.fallback).toBe(true);
    expect(result.reviewRequired).toBe(true);
    expect(result.explanation).toMatch(/could not confidently classify/i);
    expect(result.explanation).toMatch(/sent the ticket to Review/i);
  });

  it('does not confuse a password reset with a recharge', async () => {
    const result = await classify('Player forgot his password, account recovery completed');
    expect(ids(result.categories)).toContain('ACCOUNT_RECOVERY');
    expect(ids(result.categories)).not.toContain('RECHARGE');
  });

  it('awards each distinct category once when a reason combines recharge and chat resolution', async () => {
    const result = await classify('تم شحن الحساب وتم حل المشكلة عن طريق الشات');
    expect(ids(result.categories)).toEqual(['RECHARGE', 'TEXT_PROBLEM_SOLVED']);
    const base = result.categories.reduce((total, category) => total + pointsFor(category.categoryId), 0);
    expect(base).toBe(7);
  });
});

describe('taxonomy reconciliation', () => {
  it('keeps only one AnyDesk category', async () => {
    const result = await classify('AnyDesk by admin solved the problem');
    const anydeskCategories = ids(result.categories).filter((id) => id.startsWith('ANYDESK'));
    expect(anydeskCategories).toHaveLength(1);
  });

  it('recognises a problem solved through text', async () => {
    const result = await classify('تم حل المشكلة عن طريق الشات');
    expect(ids(result.categories)).toContain('TEXT_PROBLEM_SOLVED');
  });

  it('does not award solved-through-text when the reason negates the fix', async () => {
    const result = await classify('المشكلة لسه مش اتحلت');
    expect(ids(result.categories)).not.toContain('TEXT_PROBLEM_SOLVED');
  });
});

describe('compound reasons and non-scoring closures', () => {
  it.each([
    ['general question /Solving problem', ['GENERAL_QUESTION', 'TEXT_PROBLEM_SOLVED'], 7],
    ['general issue / no respond', ['GENERAL_ISSUE', 'NO_RESPONSE'], 3],
    ['report /solv problem', ['REPORT', 'TEXT_PROBLEM_SOLVED'], 8],
    ['general issue/ report', ['GENERAL_ISSUE', 'REPORT'], 5],
    ['report /generalquestio', ['GENERAL_QUESTION', 'REPORT'], 5],
    ['general issue no respond', ['GENERAL_ISSUE', 'NO_RESPONSE'], 3],
    ['acc recovery game download', ['ACCOUNT_RECOVERY', 'GENERAL_QUESTION'], 4],
    ['report and general question', ['GENERAL_QUESTION', 'REPORT'], 5],
    ['general question, report', ['GENERAL_QUESTION', 'REPORT'], 5],
    ['report + acc recovery', ['ACCOUNT_RECOVERY', 'REPORT'], 5],
    ['generalquestio/no respond', ['GENERAL_QUESTION', 'NO_RESPONSE'], 3],
    ['genral issue/no respnd', ['GENERAL_ISSUE', 'NO_RESPONSE'], 3],
    ['report/general questio', ['GENERAL_QUESTION', 'REPORT'], 5],
    ['recharge / report', ['RECHARGE', 'REPORT'], 5],
  ])('splits the compound reason %s into its scored facets', async (reason, expected, base) => {
    const result = await classify(reason);
    expect(result.fallback).toBe(false);
    expect(ids(result.categories)).toEqual(expected);
    const total = result.categories.reduce(
      (sum, category) => sum + pointsFor(category.categoryId),
      0,
    );
    expect(total).toBe(base);
  });

  it('recognises common short dashboard aliases without falling back', async () => {
    expect(ids((await classify('game password')).categories)).toEqual(['ACCOUNT_RECOVERY']);
    expect(ids((await classify('game download')).categories)).toEqual(['GENERAL_QUESTION']);
    expect(ids((await classify('Bug Report')).categories)).toEqual(['GENERAL_ISSUE']);
    expect(ids((await classify('Reported a bug in the shop')).categories)).toEqual([
      'GENERAL_ISSUE',
    ]);
    expect(ids((await classify('Script Report')).categories)).toEqual(['REPORT']);
    expect(ids((await classify('مردش لاكتر من ساعتين')).categories)).toEqual(['NO_RESPONSE']);
    expect(ids((await classify('respond /generalquestio')).categories)).toEqual([
      'GENERAL_QUESTION',
    ]);
  });

  it.each(['By Mistake', 'no reason', 'Reply received', 'تم الرد', 'فتحها بلغلط'])(
    'assigns no points and does not use the fallback for the cancellation %s',
    async (reason) => {
      const result = await classify(reason);
      expect(result.categories).toEqual([]);
      expect(result.fallback).toBe(false);
      expect(result.reviewRequired).toBe(true);
      expect(result.explanation).toMatch(/cancellation or placeholder/i);
      expect(result.reviewReasons.join(' ')).toMatch(/No scoring category/i);
    },
  );
});

describe('missing data, fallback and review', () => {
  it('assigns nothing for an empty reason', async () => {
    const result = await classifyReason('   ', 'empty', offline);
    expect(result.categories).toEqual([]);
    expect(result.fallback).toBe(false);
    expect(result.reasonState).toBe('empty');
  });

  it('does not apply the fallback when the reason could not be extracted', async () => {
    const result = await classifyReason('', 'unavailable', offline);
    expect(result.categories).toEqual([]);
    expect(result.fallback).toBe(false);
    expect(result.reviewRequired).toBe(true);
  });

  it('applies an explicit General problem fallback for unrecognised wording', async () => {
    const result = await classify('zxqv blorp wobble');
    expect(result.fallback).toBe(true);
    expect(result.method).toBe('fallback');
    expect(ids(result.categories)).toEqual(['GENERAL_ISSUE']);
    expect(result.categories[0]?.points).toBe(2);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/fallback/i);
  });

  it('reuses an approved correction ahead of every other stage', async () => {
    const result = await classifyReason('Player asked how to recharge', 'present', {
      ...offline,
      aliasLookup: () => ({
        original: 'Player asked how to recharge',
        categories: [
          { categoryId: 'GENERAL_QUESTION', points: 0, evidence: ['Approved'], method: 'human', confidence: 1 },
        ],
      }),
    });
    expect(result.method).toBe('approved_alias');
    expect(ids(result.categories)).toEqual(['GENERAL_QUESTION']);
    expect(result.categories[0]?.points).toBe(2);
  });

  it('only the offline evaluation mode consults the model', async () => {
    let calls = 0;
    const result = await classifyReason('zxqv blorp wobble', 'present', {
      ...offline,
      semanticEnabled: true,
      semanticMode: 'always',
      semantic: async () => {
        calls += 1;
        return {
          categories: [{ categoryId: 'GENERAL_QUESTION', evidence: 'an unclear inquiry', confidence: 'medium' }],
          alternatives: [],
          unresolvedPortion: null,
          reviewRequired: false,
          explanation: 'The wording is unclear but reads as a question.',
          model: 'test-model',
          latencyMs: 1,
        };
      },
    });
    expect(calls).toBe(1);
    expect(ids(result.categories)).toEqual(['GENERAL_QUESTION']);
    expect(result.method).toBe('semantic');
  });

  it('never calls the model in live mode, even for foreign wording', async () => {
    let calls = 0;
    const result = await classifyReason('zxqv blorp wobble', 'present', {
      ...offline,
      semanticEnabled: true,
      semantic: async () => {
        calls += 1;
        return {
          categories: [{ categoryId: 'GENERAL_QUESTION', evidence: 'model guess', confidence: 'high' }],
          alternatives: [],
          unresolvedPortion: null,
          reviewRequired: false,
          explanation: 'model only',
          model: 'test-model',
          latencyMs: 1,
        };
      },
    });
    expect(calls).toBe(0);
    expect(result.fallback).toBe(true);
    expect(ids(result.categories)).toEqual(['GENERAL_ISSUE']);
    expect(result.method).toBe('fallback');
    expect(result.model).toBeNull();
  });

  it('does not call the model when a strong rule match already exists', async () => {
    let calls = 0;
    const result = await classifyReason('تم شحن الحساب للاعب', 'present', {
      ...offline,
      semanticEnabled: true,
      semantic: async () => {
        calls += 1;
        return {
          categories: [{ categoryId: 'GENERAL_QUESTION', evidence: 'model guess', confidence: 'high' }],
          alternatives: [],
          unresolvedPortion: null,
          reviewRequired: false,
          explanation: 'model only',
          model: 'test-model',
          latencyMs: 1,
        };
      },
    });
    expect(calls).toBe(0);
    expect(ids(result.categories)).toEqual(['RECHARGE']);
    expect(result.method).toBe('rules_only');
    expect(result.reviewRequired).toBe(false);
  });

  it('retains both candidates and requests review when rules and model disagree', async () => {
    const result = await classifyReason('تم شحن الحساب للاعب', 'present', {
      ...offline,
      semanticEnabled: true,
      semanticMode: 'always',
      semantic: async () => ({
        categories: [{ categoryId: 'GENERAL_QUESTION', evidence: 'model guess', confidence: 'medium' }],
        alternatives: [],
        unresolvedPortion: null,
        reviewRequired: false,
        explanation: 'model only',
        model: 'test-model',
        latencyMs: 1,
      }),
    });
    expect(ids(result.categories)).toEqual(['GENERAL_QUESTION', 'RECHARGE']);
    expect(result.method).toBe('hybrid');
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/different categories/i);
  });

  it('falls back visibly instead of blocking when an evaluation model times out', async () => {
    const result = await classifyReason('zxqv blorp wobble', 'present', {
      ...offline,
      semanticEnabled: true,
      semanticMode: 'always',
      semantic: async () => {
        throw new Error('The local model did not answer within 15 seconds.');
      },
    });
    expect(result.fallback).toBe(true);
    expect(ids(result.categories)).toEqual(['GENERAL_ISSUE']);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/did not answer within 15 seconds/);
    expect(result.reviewReasons.join(' ')).toMatch(/fallback/i);
  });

  it('flags a semantic failure but keeps deterministic results', async () => {
    const result = await classifyReason('تم شحن الحساب للاعب', 'present', {
      ...offline,
      semanticEnabled: true,
      semanticMode: 'always',
      semantic: async () => {
        throw new Error('Ollama is not reachable');
      },
    });
    expect(ids(result.categories)).toEqual(['RECHARGE']);
    expect(result.reviewReasons.join(' ')).toMatch(/Ollama is not reachable/);
  });
});

describe('deterministic rules', () => {
  it('recognises the official Recharge dashboard code', () => {
    const result = classifyRules('Recharge');
    expect(result.matches.map((match) => match.categoryId)).toContain('RECHARGE');
  });

  it('tolerates a typo in a recharge phrase', () => {
    const result = classifyRules('rechrage');
    expect(result.matches.map((match) => match.categoryId)).toContain('RECHARGE');
  });
});
