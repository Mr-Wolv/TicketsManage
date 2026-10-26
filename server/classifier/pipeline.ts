import type {
  AlternativeCategory,
  CategoryAssessment,
  CategoryId,
  ClassificationMethod,
  ClassificationResult,
  ReasonState,
} from '../types.js';
import type { Db } from '../db.js';
import { FALLBACK_DISPLAY_LABEL, findApprovedReason, getUnifiedCategory, loadUnifiedTaxonomy, pointsFor } from './taxonomy.js';
import { classifyRules, type RuleMatch } from './rules.js';
import { editSimilarity, normalizeReason } from './normalize.js';
import type { SemanticClassification } from './ollama.js';

export interface AliasLookup {
  (normalizedText: string): { categories: CategoryAssessment[]; original: string } | null;
}

export interface ClassificationOptions {
  fuzzyThreshold: number;
  semanticEnabled: boolean;
  model: string | null;
  aliasLookup?: AliasLookup;
  semantic?: (reason: string) => Promise<SemanticClassification>;
  /**
   * Live classification is deterministic ('off'). The model is never allowed
   * to invent a scored category for unfamiliar wording: that wording gets the
   * explicit General problem fallback and goes to Review instead.
   * 'always' exists only for the offline model evaluation command.
   */
  semanticMode?: 'off' | 'always';
  /** Used by demo fixtures and deterministic tests so offline data is not flooded with model warnings. */
  suppressSemanticDisabledReview?: boolean;
  db?: Db;
}

const SEMANTIC_CONFIDENCE: Record<'high' | 'medium' | 'low', number> = {
  high: 0.85,
  medium: 0.7,
  low: 0.55,
};

function emptyClassification(
  rawReason: string,
  reasonState: ReasonState,
  explanation: string,
  reviewReasons: string[],
): ClassificationResult {
  return {
    categories: [],
    fallback: false,
    fallbackDisplayLabel: null,
    method: 'none',
    confidence: null,
    explanation,
    alternatives: [],
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
    unresolvedPortion: null,
    model: null,
    rawReason,
    normalizedReason: normalizeReason(rawReason),
    reasonState,
  };
}

const NON_SCORING_REASONS: RegExp[] = [
  /^(by mistake|by mistak|opened by mistake|opened by accident|opened it by mistake|opened by error)$/,
  /^(no reason|no reason specified|no reason given|none|not applicable|n a|na|nr)$/,
  /^(تم الرد|reply received|رد)$/,
  /^(فتحها بلغلط|فتحتها بلغلط|فتحت غلطه|فتحه بلغلط|فتحها بالغلط)$/,
];

/**
 * A cancellation or placeholder is not a foreign support reason. It must not
 * receive the General problem fallback (and its 2 provisional points): there
 * was no support work to score. Keeping the zero in Review makes the decision
 * visible without inventing an award.
 */
function isNonScoringReason(normalized: string): boolean {
  return NON_SCORING_REASONS.some((pattern) => pattern.test(normalized));
}

function toAssessment(
  match: RuleMatch,
  db?: Db,
): CategoryAssessment {
  return {
    categoryId: match.categoryId,
    points: pointsFor(match.categoryId, db),
    evidence: match.evidence,
    method: match.exact ? 'exact' : match.fuzzy ? 'fuzzy' : 'exact',
    confidence: Number(match.confidence.toFixed(2)),
  };
}

function findAnyDeskCategory(ids: Set<CategoryId>): 'ANYDESK' | 'ANYDESK_BY' | null {
  if (ids.has('ANYDESK_BY')) return 'ANYDESK_BY';
  if (ids.has('ANYDESK')) return 'ANYDESK';
  return null;
}

/**
 * Hybrid classification:
 * approved corrections -> deterministic aliases -> fuzzy -> local semantic model
 * -> reconciliation -> explicit fallback.
 *
 * The model never sets point values. Those always come from the fixed taxonomy.
 */
export async function classifyReason(
  rawReason: string,
  reasonState: ReasonState,
  options: ClassificationOptions,
): Promise<ClassificationResult> {
  const normalized = normalizeReason(rawReason);
  if (reasonState === 'unavailable') {
    return emptyClassification(
      rawReason,
      reasonState,
      'The closing reason could not be extracted from the dashboard. No fallback category was applied because this is missing source data, not an empty reason.',
      ['Closing reason was unavailable; classification and staff credit need review.'],
    );
  }
  if (reasonState === 'empty' || normalized.length === 0) {
    return emptyClassification(
      rawReason,
      'empty',
      'The closing reason is empty. No category or points were assigned; this is not the General problem fallback.',
      [],
    );
  }

  // Approved human corrections are authoritative and improve future runs.
  const approved = options.aliasLookup?.(normalized) ?? null;
  if (approved && approved.categories.length > 0) {
    const categories = approved.categories.map((category) => ({
      ...category,
      points: pointsFor(category.categoryId, options.db),
      method: 'approved_alias' as const,
      confidence: 0.99,
    }));
    return {
      categories,
      fallback: false,
      fallbackDisplayLabel: null,
      method: 'approved_alias',
      confidence: 0.99,
      explanation: `An approved manager correction for this exact wording was reused: ${getUnifiedCategory(options.db, categories[0]!.categoryId)!.code}.`,
      alternatives: [],
      reviewRequired: false,
      reviewReasons: [],
      unresolvedPortion: null,
      model: null,
      rawReason,
      normalizedReason: normalized,
      reasonState,
    };
  }

  // Fuzzy match against approved reasons (broader than exact aliases).
  const approvedReason = options.db ? findApprovedReason(options.db, normalized) : null;
  if (approvedReason) {
    const categories: CategoryAssessment[] = [
      {
        categoryId: approvedReason.categoryId,
        points: pointsFor(approvedReason.categoryId, options.db),
        evidence: [`Approved reason fuzzy match: "${approvedReason.text}"`],
        method: 'approved_reason' as ClassificationMethod,
        confidence: 0.85,
      },
    ];
    return {
      categories,
      fallback: false,
      fallbackDisplayLabel: null,
      method: 'approved_reason' as ClassificationMethod,
      confidence: 0.85,
      explanation: `An approved manager correction with similar wording was reused: ${getUnifiedCategory(options.db, approvedReason.categoryId)!.code}.`,
      alternatives: [],
      reviewRequired: false,
      reviewReasons: [],
      unresolvedPortion: null,
      model: null,
      rawReason,
      normalizedReason: normalized,
      reasonState,
    };
  }

  if (isNonScoringReason(normalized)) {
    return emptyClassification(
      rawReason,
      reasonState,
      'I did not apply the General problem fallback because this closing reason is a cancellation or placeholder rather than a support reason. No category or points were assigned; the ticket is in Review so the zero can be confirmed or corrected.',
      [
        'No scoring category: the closing reason is a cancellation or generic closure, not support work.',
      ],
    );
  }

  const ruleResult = classifyRules(rawReason, options.fuzzyThreshold);
  const rules: RuleMatch[] = ruleResult.matches;
  const strongRules = rules.filter((match) => match.confidence >= 0.9);
  const reviewReasons: string[] = [];
  const alternatives: AlternativeCategory[] = [];
  let semantic: SemanticClassification | null = null;
  let semanticError: string | null = null;

  // Known wording must not wait for the model. This is the difference between
  // a usable collector and one that spends 15 seconds per ticket confirming
  // what the rules already know.
  const semanticEligible =
    options.semanticMode === 'always' &&
    options.semanticEnabled &&
    Boolean(options.semantic);

  if (semanticEligible) {
    try {
      semantic = await options.semantic!(rawReason);
    } catch (error) {
      semanticError = error instanceof Error ? error.message : 'The local model failed.';
      semantic = null;
    }
  }

  const categoryMap = new Map<CategoryId, CategoryAssessment>();
  const ruleIds = new Set(rules.map((match) => match.categoryId));

  for (const rule of rules) {
    categoryMap.set(rule.categoryId, toAssessment(rule, options.db));
  }

  if (options.db) {
    const unifiedCategories = loadUnifiedTaxonomy(options.db);
    const customCategories = Object.values(unifiedCategories).filter((category) => category.isCustom);
    for (const custom of customCategories) {
      for (const example of custom.examples) {
        const similarity = editSimilarity(normalized, normalizeReason(example));
        if (similarity >= 0.8) {
          categoryMap.set(custom.id as CategoryId, {
            categoryId: custom.id as CategoryId,
            points: custom.points,
            evidence: [`Custom category example match: "${example}"`],
            method: 'custom',
            confidence: Number(similarity.toFixed(2)),
          });
          break;
        }
      }
    }
  }

  if (semantic) {
    for (const modelCategory of semantic.categories) {
      const assessment: CategoryAssessment = {
        categoryId: modelCategory.categoryId,
        points: pointsFor(modelCategory.categoryId, options.db),
        evidence: [
          modelCategory.evidence
            ? `Model interpretation: ${modelCategory.evidence}`
            : 'Model interpretation of the complete closing reason',
        ],
        method: ruleIds.has(modelCategory.categoryId) ? 'hybrid' : 'semantic',
        confidence: modelCategory.confidence
          ? SEMANTIC_CONFIDENCE[modelCategory.confidence]
          : 0.7,
      };
      const existing = categoryMap.get(modelCategory.categoryId);
      if (!existing) {
        categoryMap.set(modelCategory.categoryId, assessment);
      } else {
        existing.method = 'hybrid';
        existing.evidence = [...new Set([...existing.evidence, ...assessment.evidence])];
        existing.confidence = Math.max(existing.confidence ?? 0, assessment.confidence ?? 0);
      }
    }
    for (const alternative of semantic.alternatives) {
      alternatives.push({
        categoryId: alternative.categoryId,
        reason: alternative.reason || 'The model considered this category plausible.',
        source: 'model',
      });
    }
  }

  // ---- Reconcile overlapping categories ---------------------------------
  const anydesk = findAnyDeskCategory(new Set(categoryMap.keys()));
  if (anydesk && categoryMap.has('ANYDESK') && categoryMap.has('ANYDESK_BY')) {
    const explicitBy =
      /anydesk (by|was done by)|by (another )?(staff|admin|support|moderator)|بواسط|من قبل|عن طريق موظف/i.test(
        normalized,
      );
    const keep: CategoryId = explicitBy ? 'ANYDESK_BY' : 'ANYDESK';
    const drop: CategoryId = keep === 'ANYDESK' ? 'ANYDESK_BY' : 'ANYDESK';
    categoryMap.delete(drop);
    alternatives.push({
      categoryId: drop,
      reason:
        'AnyDesk wording overlaps both categories; only the single best-fitting category may be scored.',
      source: 'reconciliation',
    });
    reviewReasons.push(
      'AnyDesk and AnyDesk By were both plausible; one interpretation was selected and the alternative is retained.',
    );
  }

  // A text-solved claim must actually describe written/chat resolution.
  if (categoryMap.has('TEXT_PROBLEM_SOLVED')) {
    const solvedFacet = categoryMap.get('TEXT_PROBLEM_SOLVED')!;
    const anydeskFacet = findAnyDeskCategory(new Set(categoryMap.keys()));
    const chatEvidence = /chat|text|written|conversation|message|شات|كتابه|كلام|رسايل|رسائل/i.test(
      `${normalized} ${solvedFacet.evidence.join(' ')}`,
    );
    const negatedSolved =
      /(not|never|couldnt|could not|didnt|did not)\s+(solved|fixed|resolved)|(مش|لم|ما)\s*(اتحلت|تحل|محلول)|لسه\s*(متحله|مش متحله)/i.test(
        normalized,
      );
    if (negatedSolved) {
      categoryMap.delete('TEXT_PROBLEM_SOLVED');
      alternatives.push({
        categoryId: 'TEXT_PROBLEM_SOLVED',
        reason: 'The reason appears to negate that the problem was solved.',
        source: 'reconciliation',
      });
      reviewReasons.push('The closing reason mentions solving but appears to negate it.');
    } else if (anydeskFacet && !chatEvidence) {
      categoryMap.delete('TEXT_PROBLEM_SOLVED');
      alternatives.push({
        categoryId: 'TEXT_PROBLEM_SOLVED',
        reason:
          'The reason describes an AnyDesk resolution rather than a problem solved through written conversation.',
        source: 'reconciliation',
      });
    }
  }

  // Material disagreement: retain both candidates, but require human review.
  if (semantic && strongRules.length > 0) {
    const modelIds = new Set(semantic.categories.map((category) => category.categoryId));
    const strongIds = new Set(strongRules.map((rule) => rule.categoryId));
    const intersects = [...modelIds].some((id) => strongIds.has(id));
    if (!intersects) {
      reviewReasons.push(
        'Rule-based matching and the local semantic model selected different categories; both candidates are retained for review.',
      );
    }
  }

  if (semantic?.reviewRequired) {
    reviewReasons.push('The local semantic model requested human review of this reason.');
  }
  if (semantic?.unresolvedPortion) {
    reviewReasons.push(
      `The model could not confidently resolve part of the reason: ${semantic.unresolvedPortion}`,
    );
  }
  if (semanticError) {
    reviewReasons.push(`Semantic classification was unavailable: ${semanticError}`);
  }
  if (!options.semanticEnabled && !options.suppressSemanticDisabledReview) {
    reviewReasons.push(
      'Semantic classification is disabled in Settings; only rule-based matching was used.',
    );
  }
  if (alternatives.some((alternative) => alternative.source === 'model')) {
    reviewReasons.push(
      'The semantic model considered alternative categories that were not selected.',
    );
  }
  if (rules.some((rule) => rule.fuzzy) && !semantic) {
    reviewReasons.push('Classification relied on typo-tolerant fuzzy matching without a model.');
  }

  // ---- Fallback ---------------------------------------------------------
  if (categoryMap.size === 0) {
    const fallbackCategory: CategoryAssessment = {
      categoryId: 'GENERAL_ISSUE',
      points: pointsFor('GENERAL_ISSUE', options.db),
      evidence: ['Explicit fallback applied by the application, not by the model'],
      method: 'fallback',
      confidence: null,
    };
    reviewReasons.push(
      'I could not confidently classify this closing reason. General problem fallback applied for review.',
    );
    return {
      categories: [fallbackCategory],
      fallback: true,
      fallbackDisplayLabel: FALLBACK_DISPLAY_LABEL,
      method: 'fallback',
      confidence: null,
      explanation: `I could not confidently classify this closing reason.${
        semanticError ? ` The local model was unavailable (${semanticError}).` : ''
      } I applied the General problem fallback (General Issue, ${fallbackCategory.points} base points) and sent the ticket to Review. Choose the correct category there; the correction is reused for this exact wording next time.`,
      alternatives: dedupeAlternatives(alternatives),
      reviewRequired: true,
      reviewReasons: [...new Set(reviewReasons)],
      unresolvedPortion: semantic?.unresolvedPortion ?? null,
      // Only report a model when the model actually ran. A deterministic
      // guard/fallback must not look like a semantic classification.
      model: semantic?.model ?? null,
      rawReason,
      normalizedReason: normalized,
      reasonState,
    };
  }

  // ---- Final assembly ---------------------------------------------------
  const categories = [...categoryMap.values()].sort(
    (a, b) => a.points - b.points || a.categoryId.localeCompare(b.categoryId),
  );
  const usedSemantic = Boolean(semantic);
  const usedRules = rules.length > 0;
  const method: ClassificationMethod = usedSemantic && usedRules ? 'hybrid' : usedSemantic ? 'semantic' : 'rules_only';
  const confidences = categories
    .map((category) => category.confidence)
    .filter((value): value is number => typeof value === 'number');
  const confidence = confidences.length
    ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(2))
    : null;
  if (confidence !== null && confidence < 0.6) {
    reviewReasons.push('Classification confidence is low; the result should be reviewed.');
  }
  if (semantic?.unresolvedPortion) {
    // Kept visible in review reasons above; no additional fallback is added.
  }

  const selectedLabels = categories.map((category) => {
    const definition = getUnifiedCategory(options.db, category.categoryId);
    return `${definition!.code} (${category.points} points)`;
  });
  const evidenceSummary = categories
    .flatMap((category) => category.evidence.map((evidence) => `${category.categoryId}: ${evidence}`))
    .join(' ');
  const explanation = [
    `Selected ${selectedLabels.join(' + ')}.`,
    evidenceSummary,
    semantic?.explanation ? `Model: ${semantic.explanation}` : '',
    semanticError ? `Semantic stage unavailable: ${semanticError}` : '',
    !options.semanticEnabled && !options.suppressSemanticDisabledReview
      ? 'Semantic stage disabled in settings.'
      : '',
    'Point values were assigned by the application from the taxonomy (fixed or overridden).',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    categories,
    fallback: false,
    fallbackDisplayLabel: null,
    method,
    confidence,
    explanation,
    alternatives: dedupeAlternatives(alternatives).filter(
      (alternative) => !categories.some((category) => category.categoryId === alternative.categoryId),
    ),
    reviewRequired: reviewReasons.length > 0,
    reviewReasons: [...new Set(reviewReasons)],
    unresolvedPortion: semantic?.unresolvedPortion ?? null,
    model: semantic?.model ?? null,
    rawReason,
    normalizedReason: normalized,
    reasonState,
  };
}

function dedupeAlternatives(items: AlternativeCategory[]): AlternativeCategory[] {
  const seen = new Set<string>();
  const result: AlternativeCategory[] = [];
  for (const item of items) {
    if (seen.has(item.categoryId)) continue;
    seen.add(item.categoryId);
    result.push(item);
  }
  return result;
}
