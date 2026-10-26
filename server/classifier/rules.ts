import type { CategoryId } from '../types.js';
import { editSimilarity, isNegated, normalizeReason, similarity } from './normalize.js';
import { TAXONOMY_BY_ID } from './taxonomy.js';

export interface RuleMatch {
  categoryId: CategoryId;
  evidence: string[];
  confidence: number;
  exact: boolean;
  fuzzy: boolean;
}

interface RuleResult {
  matches: RuleMatch[];
  anydeskMentioned: boolean;
  textConversationMentioned: boolean;
}

/**
 * Supplemental multilingual aliases. These are intentionally broad but the
 * semantic model remains the primary interpretation for unfamiliar wording.
 * The taxonomy itself is fixed; aliases never create new categories.
 */
const ALIASES: Record<CategoryId, string[]> = {
  REPORT: [
    'report',
    'report about a player',
    'report against a player',
    'report for insult',
    'report for abuse',
    'report for harassment',
    'reported for abuse',
    'reported for insult',
    'reported for toxic',
    'abuse report',
    'insult report',
    'harassment report',
    'player insulted',
    'player was insulting',
    'player is insulting',
    'player swore',
    'player swearing',
    'player used bad words',
    'player used profanity',
    'toxic behaviour',
    'toxic behavior',
    'abusive language',
    'insults',
    'profanity',
    'بلاغ',
    'البلاغ',
    'بلاغ عن لاعب',
    'بلاغ عن اساءه',
    'بلاغ عن شتيمه',
    'اللاعب بيشتم',
    'اللاعب شتمني',
    'اللاعب سبني وشتمني',
    'سبني وشتمني',
    'شتمني',
    'سبني',
    'بيشتم الناس',
    'اساءه لفظيه',
    'اهانه',
    'تحرش',
    'بذاءه',
    'شتايم',
    'سباب',
    'shtama',
    'shtamni',
    'sabb',
    'sabni',
    'shtama wa sabb',
    'sabb wa shtama',
    'shatema',
    'insult',
    'bad words',
    'report abuse',
    'report check',
    'ranked report',
    'script report',
    'blagh 3an',
    'blag 3an',
    'shtima',
    'shtaem',
  ],
  GENERAL_ISSUE: [
    'general issue',
    'general',
    'general problem',
    'bug report',
    'report bug',
    'reported a bug',
    'server wide issue',
    'server wide problem',
    'affecting multiple players',
    'affecting all players',
    'affects everyone',
    'all players affected',
    'global issue',
    'bug for everyone',
    'server issue affecting everyone',
    'مشكله عامه',
    'مشكله في السيرفر',
    'مشكله بالسيرفر',
    'مشكله تؤثر على الجميع',
    'كل اللاعبين',
    'جميع اللاعبين',
    'عامه',
    'عام',
    'moshkela 3ama',
    'mushkila 3amma',
    'moshkela fel server',
    'issue affecting all',
  ],
  GENERAL_QUESTION: [
    'general question',
    'question',
    'question about',
    'asked about',
    'asked how',
    'asked what',
    'asked why',
    'inquiry about',
    'enquiry about',
    'information request',
    'wanted to know',
    'wants to know',
    'how to',
    'game download',
    'download game',
    'download the game',
    'what is',
    'why is',
    'سؤال',
    'السؤال',
    'استفسار',
    'استفسار عن',
    'سال عن',
    'سالت عن',
    'سال ازاي',
    'سأل ازاي',
    'بسال',
    'بسأل',
    'عايز اعرف',
    'عاوز اعرف',
    'ممكن اعرف',
    'كيف',
    'ليه',
    'ايه',
    'ما هو',
    'ما هي',
    'so2al',
    'sual',
    's2al',
    'istifsar',
    'basa2al',
    'bes2al',
    'bes2al 3an',
    'kan bes2al 3an',
    '3ayez a3raf',
  ],
  NO_RESPONSE: [
    'no response',
    'no respond',
    'no respnd',
    'no responce',
    'no reponse',
    'no respose',
    'no reply',
    'no answer',
    'player did not respond',
    'player didnt respond',
    'player did not reply',
    'player didnt reply',
    'did not respond',
    'didnt respond',
    'failed to respond',
    'inactivity',
    'inactive',
    'closed for inactivity',
    'timed out',
    'timeout',
    'ghosted',
    'no response from player',
    'no response from the player',
    'player left',
    'player never replied',
    'never replied',
    'unresponsive',
    'لا رد',
    'مفيش رد',
    'مافيش رد',
    'مردش',
    'مارد',
    'ما ردش',
    'لم يرد',
    'عدم الرد',
    'اللاعب مردش',
    'اللاعب مارد',
    'مردش لاكتر',
    'مردش اكتر',
    'مردش لمده',
    'مردش لمدة',
    'مردش اكثر من',
    'خمول',
    'غير نشط',
    'عدم تفاعل',
    'انتهت المده',
    'قفلت لعدم الرد',
    'mafish rad',
    'mafeesh rad',
    'mrdsh',
    'ma rad',
    'no rad',
    '5omol',
    '3adam el rad',
    'player mrdsh',
  ],
  UNBANNED: [
    'unbanned',
    'unban',
    'ban lifted',
    'ban removed',
    'lifted the ban',
    'removed the ban',
    'ban appeal accepted',
    'anticheat ban removed',
    'anti cheat ban lifted',
    'player was unbanned',
    'was unbanned',
    'unbanned after',
    'تم رفع الحظر',
    'رفع الحظر',
    'فك الحظر',
    'الغاء الحظر',
    'تم فك البان',
    'شيل البان',
    'رفع البان',
    'فك البان',
    'تم رفع البان',
    'ban etshal',
    'raf3 el ban',
    'fak el ban',
    'el ban etshal',
  ],
  ANYDESK: [
    'anydesk',
    'any desk',
    'remote session',
    'remote support',
    'remote desktop',
    'via anydesk',
    'through anydesk',
    'solved via anydesk',
    'fixed via anydesk',
    'anydesk session',
    'anydesk fixed',
    'اني ديسك',
    'عن طريق اني ديسك',
    'دخلت اني ديسك',
    'بواسطه اني ديسك',
    'جلسه ريموت',
    '3an tari2 anydesk',
    'remotely',
  ],
  ANYDESK_BY: [
    'anydesk by',
    'anydesk was done by',
    'performed by',
    'by another staff',
    'by a staff member',
    'by admin',
    'by support',
    'anydesk by support',
    'anydesk by admin',
    'anydesk by staff',
    'handled by',
    'بواسطه',
    'من قبل',
    'عن طريق موظف',
    'بواسطه موظف',
    'بواسطه الادمن',
    'عملها موظف',
    'سواها موظف',
    'by staff',
    '3amalha moderator',
  ],
  ACCOUNT_RECOVERY: [
    'account recovery',
    'recover account',
    'recovered account',
    'recover the account',
    'password reset',
    'reset password',
    'forgot password',
    'forgot the password',
    'game password',
    'game pass',
    'account hacked',
    'recover hacked account',
    'email recovery',
    'restore account',
    'account restore',
    'استعاده الحساب',
    'استرجاع الحساب',
    'نسيت كلمه المرور',
    'نسي كلمه المرور',
    'تغيير كلمه المرور',
    'تغيير الباسورد',
    'استرجاع الباسورد',
    'باسورد',
    'اختراق الحساب',
    'حساب مخترق',
    'استعاده',
    'acc recovery',
    'nset el password',
    'bassword',
    '2st3adt el 7sab',
    'recover acc',
  ],
  RECHARGE: [
    'recharge',
    'recharged',
    'recharge completed',
    'account recharge',
    'player recharge',
    'top up',
    'top-up',
    'topup',
    'top up completed',
    'balance top up',
    'credit top up',
    'تم الشحن',
    'تم شحن الحساب',
    'شحنت الحساب',
    'شحن الحساب',
    'شحنت اللعبه',
    'شحن اللعبه',
    'شحنه اللاعب',
    'الشحن تم',
    'شحن',
    'shahn',
    'sh7an',
    'sha7n',
    'tm el shahn',
    'shahnet el 7sab',
    'topup done',
  ],
  TEXT_PROBLEM_SOLVED: [
    'problem solved',
    'problem solve',
    'problem solving',
    'solving problem',
    'solve problem',
    'solv problem',
    'problem solv',
    'solved problem',
    'issue solved',
    'problem resolved',
    'issue resolved',
    'fixed the problem',
    'problem fixed',
    'solved through text',
    'explained the fix in text',
    'solved in chat',
    'resolved in chat',
    'solved via chat',
    'solved through conversation',
    'solved by texting',
    'explained and fixed',
    'worked after explanation',
    'it works now',
    'the issue is fixed',
    'resolved the issue',
    'تم حل المشكله',
    'المشكله اتحلت',
    'حل المشكله',
    'حليت المشكله',
    'تم الحل',
    'اتحلت',
    'المشكله خلصت',
    'تم حلها',
    'حل المشكله عن طريق الشات',
    'عن طريق الشات',
    'بالشات',
    'بالكلام',
    'solved',
    'resolved',
    'fixed',
    'et7allet',
    'et7allet bel chat',
    '7allet',
    'el moshkela et7allet',
    'solved bel chat',
    'fixed fel chat',
  ],
};

const EXACT_ONLY = new Set([
  'report',
  'question',
  'insult',
  'general issue',
  'general problem',
  'general question',
  'no response',
  'unbanned',
  'unban',
  'anydesk',
  'any desk',
  'remote session',
  'remote support',
  'remote desktop',
  'remotely',
  'solved',
  'resolved',
  'fixed',
  'recovery',
  'باسورد',
  'استعاده',
  'recharge',
  'شحن',
  'اتحلت',
  'بالشات',
  'بالكلام',
  'عام',
  'عامه',
  'بواسطه',
  'من قبل',
  'نr',
  'nr',
  'n/a',
  'none',
  'no reason',
  'no reason specified',
]);

const OFFICIAL_CODES: Array<[string, CategoryId]> = [
  ['report', 'REPORT'],
  ['general issue', 'GENERAL_ISSUE'],
  ['general question', 'GENERAL_QUESTION'],
  ['no response', 'NO_RESPONSE'],
  ['unbanned', 'UNBANNED'],
  ['anydesk', 'ANYDESK'],
  ['anydesk by', 'ANYDESK_BY'],
  ['acc recovery', 'ACCOUNT_RECOVERY'],
  ['account recovery', 'ACCOUNT_RECOVERY'],
  ['problem solved through text', 'TEXT_PROBLEM_SOLVED'],
  ['text problem solved', 'TEXT_PROBLEM_SOLVED'],
  ['recharge', 'RECHARGE'],
];

const normalizedAliases = (Object.entries(ALIASES) as Array<[CategoryId, string[]]>).map(
  ([categoryId, phrases]) => ({
    categoryId,
    entries: phrases.map((phrase) => ({
      raw: phrase,
      normalized: normalizeReason(phrase),
      exactOnly: EXACT_ONLY.has(normalizeReason(phrase)),
    })),
  }),
);

function containsPhrase(haystack: string, phrase: string): number {
  if (!phrase) return -1;
  const padded = ` ${haystack} `;
  const needle = ` ${phrase} `;
  return padded.indexOf(needle);
}

function countTokens(input: string): number {
  return input.split(/\s+/).filter(Boolean).length;
}

/**
 * Split compound dashboard reasons ("general question / solving problem",
 * "report\nno respond") into independently matchable facets. This must run on
 * the raw text: normalisation intentionally turns punctuation into spaces, so
 * splitting afterwards would lose the facet boundaries. The full text is
 * still checked first so ordinary prose is not treated as a list.
 */
function splitReasonSegments(rawReason: string): string[] {
  return rawReason
    .split(/[\/\n;|&,،+]|\s+(?:and|plus|و)\s+/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function collectRuleMatches(
  text: string,
  fuzzyThreshold: number,
  matches: Map<CategoryId, RuleMatch>,
): void {
  for (const { categoryId, entries } of normalizedAliases) {
    for (const entry of entries) {
      if (!entry.normalized) continue;
      let score = 0;
      let evidence = '';
      let exact = false;
      let fuzzy = false;

      if (text === entry.normalized) {
        score = 1;
        exact = true;
        evidence = `Exact match: "${entry.raw}"`;
      } else if (countTokens(entry.normalized) >= 2) {
        // Multi-word aliases are safe to find anywhere in a facet, even when a
        // dashboard reason writes two purposes without a separator
        // ("general issue no respond"). Single-word codes remain exact-only so
        // prose such as "player asked how to recharge" is not mis-scored.
        const index = containsPhrase(text, entry.normalized);
        if (index >= 0 && !(categoryId === 'TEXT_PROBLEM_SOLVED' && isNegated(text, entry.normalized, index))) {
          score = 0.9;
          evidence = `Known phrasing: "${entry.raw}"`;
        }
      }

      if (score === 0 && entry.normalized.length >= 5 && countTokens(entry.normalized) >= 1) {
        const sim = Math.max(
          similarity(text, entry.normalized),
          editSimilarity(text, entry.normalized),
        );
        if (sim >= fuzzyThreshold) {
          score = Math.min(0.86, 0.55 + sim * 0.35);
          fuzzy = true;
          evidence = `Resembles known phrasing: "${entry.raw}" (similarity ${sim.toFixed(2)})`;
        }
      }

      if (score > 0) {
        const existing = matches.get(categoryId);
        if (!existing || score > existing.confidence) {
          matches.set(categoryId, {
            categoryId,
            evidence: evidence ? [evidence] : [],
            confidence: score,
            exact: exact || existing?.exact === true,
            fuzzy: fuzzy && !exact,
          });
        }
      }
    }
  }

  // Official dashboard codes are authoritative when a facet is exactly a code.
  for (const [code, categoryId] of OFFICIAL_CODES) {
    const normalizedCode = normalizeReason(code);
    if (text === normalizedCode) {
      matches.set(categoryId, {
        categoryId,
        evidence: [`Closing code: "${code}"`],
        confidence: 1,
        exact: true,
        fuzzy: false,
      });
    }
  }
}

/**
 * Deterministic stage: exact/known aliases plus typo-tolerant similarity.
 * Returns at most one best match per category; never invents categories.
 */
export function classifyRules(
  rawReason: string,
  fuzzyThreshold = 0.82,
): RuleResult {
  const normalized = normalizeReason(rawReason);
  const matches = new Map<CategoryId, RuleMatch>();
  const anydeskMentioned = /anydesk|any desk|اني ديسك|ريموت|remote/.test(normalized);
  const textConversationMentioned =
    /chat|text|conversation|wrote|written|message|messages|شات|كتابه|كلام|رسايل|رسائل|bel chat|fel chat/.test(
      normalized,
    );

  collectRuleMatches(normalized, fuzzyThreshold, matches);
  const seenSegments = new Set([normalized]);
  for (const rawSegment of splitReasonSegments(rawReason)) {
    const segment = normalizeReason(rawSegment);
    if (!segment || seenSegments.has(segment)) continue;
    seenSegments.add(segment);
    collectRuleMatches(segment, fuzzyThreshold, matches);
  }

  // "without reason" / placeholder reasons are not classified here; the caller
  // distinguishes an empty reason from a failed extraction before calling.

  // "Staff did not respond" / "الموظف مردش" describe a staff failure, not a
  // player who was inactive, so they must not earn the No Response category.
  const staffNoResponse =
    /(staff|admin|moderator|support|team)\s+(did not|didnt|does not|never)\s+(respond|reply|answer)|(الموظف|الادمن|المشرف|الاداره)\s+(مردش|مارد|ما رد|لم يرد|مبيردش)/i.test(
      normalized,
    );
  if (staffNoResponse) {
    matches.delete('NO_RESPONSE');
  }

  // A bare "respond" is not a no-response outcome. Require explicit evidence
  // of silence/inactivity so a word like "respond /general question" cannot
  // fuzzy-match "no response".
  const noResponseEvidence =
    /no (response|respond|respnd|responce|reponse|respose|reply|answer)|did not (respond|reply|answer)|didnt (respond|reply|answer)|failed to respond|inactiv|timed out|timeout|ghosted|unresponsive|player left|never replied|mafish|mafeesh|mrdsh|ma rad|no rad|3adam el rad|5omol|مردش|مارد|ما رد|لم يرد|عدم الرد|مفيش|مافيش|لا رد|خمول|غير نشط|عدم تفاعل|انتهت المده|قفلت لعدم الرد/i.test(
      normalized,
    );
  if (matches.has('NO_RESPONSE') && !noResponseEvidence) {
    matches.delete('NO_RESPONSE');
  }

  // AnyDesk wording is meaningful even in mixed Arabic/English text where the
  // alias table may not include the exact phrase. When the reason explicitly
  // credits another staff member, that is the AnyDesk By category; never both.
  const anydeskAttributedToStaff =
    anydeskMentioned &&
    !/by myself|بنفسي/i.test(normalized) &&
    /anydesk.*\b(by|done by)\b|\bby\b.*\b(staff|admin|moderator|support|team)\b|بواسط|من قبل|عن طريق (احد )?(ال)?موظف|عملها موظف|سواها موظف/i.test(
      normalized,
    );
  if (anydeskMentioned) {
    if (anydeskAttributedToStaff) {
      matches.delete('ANYDESK');
      if (!matches.has('ANYDESK_BY')) {
        matches.set('ANYDESK_BY', {
          categoryId: 'ANYDESK_BY',
          evidence: ['Reason mentions an AnyDesk session attributed to another staff member'],
          confidence: 0.9,
          exact: false,
          fuzzy: false,
        });
      }
    } else if (!matches.has('ANYDESK') && !matches.has('ANYDESK_BY')) {
      matches.set('ANYDESK', {
        categoryId: 'ANYDESK',
        evidence: ['Reason mentions an AnyDesk remote session'],
        confidence: 0.85,
        exact: false,
        fuzzy: false,
      });
    }
  }

  return {
    matches: [...matches.values()].sort((a, b) => b.confidence - a.confidence),
    anydeskMentioned,
    textConversationMentioned,
  };
}

export function categoryLabel(categoryId: CategoryId): string {
  return TAXONOMY_BY_ID[categoryId]!.label;
}
