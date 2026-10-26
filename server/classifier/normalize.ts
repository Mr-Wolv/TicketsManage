const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const TATWEEL = /\u0640/g;

/** Convert Arabic-Indic and Eastern Arabic-Indic digits to ASCII. */
function normalizeDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * Normalise a separate representation for matching. The original reason is
 * always preserved by the caller and is never mutated here.
 */
export function normalizeReason(input: string): string {
  let text = input.normalize('NFKC').toLowerCase();
  text = normalizeDigits(text);
  text = text.replace(ZERO_WIDTH, ' ').replace(TATWEEL, '');
  text = text.replace(ARABIC_DIACRITICS, '');
  // Normalise common Arabic letter variants before punctuation stripping.
  text = text
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A');
  // Latin diacritics.
  text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Normalise punctuation and symbols to spaces but keep letters/digits.
  text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function compactNormalized(input: string): string {
  return normalizeReason(input).replace(/\s+/g, '');
}

export function tokenize(input: string): string[] {
  return normalizeReason(input).split(' ').filter(Boolean);
}

/** Dice coefficient over character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const left = a.replace(/\s+/g, '');
  const right = b.replace(/\s+/g, '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const grams = (value: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const aGrams = grams(left);
  const bGrams = grams(right);
  let overlap = 0;
  for (const [gram, count] of aGrams) {
    const other = bGrams.get(gram) ?? 0;
    overlap += Math.min(count, other);
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1);
}

/**
 * Optimal-string-alignment distance: insertions, deletions, substitutions and
 * adjacent transpositions each cost one edit. Transpositions are common in
 * fast staff shorthand ("rechrage"), which plain bigram overlap misses.
 */
export function editDistance(a: string, b: string): number {
  const left = a.replace(/\s+/g, '');
  const right = b.replace(/\s+/g, '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, beforePrevious[j - 2]! + 1);
      }
      current[j] = value;
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length]!;
}

/** 0..1 similarity that tolerates typos and adjacent transpositions. */
export function editSimilarity(a: string, b: string): number {
  const length = Math.max(a.replace(/\s+/g, '').length, b.replace(/\s+/g, '').length);
  if (length === 0) return 1;
  return Math.max(0, 1 - editDistance(a, b) / length);
}

const NEGATION_TOKENS = new Set([
  'not',
  'no',
  'never',
  'cannot',
  'cant',
  'couldnt',
  'didnt',
  'doesnt',
  'wasnt',
  'isnt',
  'unsolved',
  'unresolved',
  'مش',
  'ما',
  'مفيش',
  'لم',
  'لن',
  'غير',
  'مازال',
  'لسه',
  'لم يتم',
  'متمش',
  'مش محلول',
]);

/** True when a positive phrase such as "solved" is negated nearby. */
export function isNegated(normalized: string, phrase: string, phraseIndex: number): boolean {
  const before = normalized.slice(0, phraseIndex).trim().split(/\s+/).slice(-3);
  if (before.some((token) => NEGATION_TOKENS.has(token))) return true;
  const after = normalized.slice(phraseIndex + phrase.length).trim().split(/\s+/).slice(0, 2);
  return after.some((token) => NEGATION_TOKENS.has(token));
}

export function hasLatin(input: string): boolean {
  return /[a-z]/i.test(input);
}
