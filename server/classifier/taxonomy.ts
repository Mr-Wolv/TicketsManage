import type { CategoryId } from '../types.js';
import type { Db } from '../db.js';
import { editSimilarity } from './normalize.js';

export interface TaxonomyCategory {
  id: string;
  code: string;
  label: string;
  labelAr: string;
  description: string;
  points: number;
  distinction?: string;
  examples: string[];
  negativeExamples?: string[];
  isCustom?: boolean;
}

export const TAXONOMY: readonly TaxonomyCategory[] = [
  {
    id: 'REPORT',
    code: 'Report',
    label: 'Report',
    labelAr: 'بلاغ',
    points: 3,
    description: 'A report concerning profanity, insults, or abusive language.',
    distinction:
      'This is an abuse/conduct report. A technical bug report or problem report is not this category.',
    examples: [
      'Player was insulting and swearing at others',
      'بلاغ عن لاعب بيشتم الناس',
      'اللاعب سبني وشتمني في الشات',
      'shtama wa sabb fel chat',
      'reported for toxic behaviour and harassment',
    ],
    negativeExamples: ['Reported a bug in the shop', 'بلاغ عن مشكلة تقنية'],
  },
  {
    id: 'GENERAL_ISSUE',
    code: 'General Issue',
    label: 'General issue',
    labelAr: 'مشكلة عامة',
    points: 2,
    description: 'A general issue affecting multiple players.',
    distinction:
      'Use only when the reason describes a broad/global problem, not a single player’s individual problem. The fallback also uses this category, but the fallback flag remains visible.',
    examples: [
      'General issue affecting all players on the server',
      'مشكلة عامة في السيرفر بتأثر على كل اللاعبين',
      'server-wide bug for everyone',
      'moshkela 3ama lel mo5dm',
    ],
    negativeExamples: ['Player forgot his password', 'اللاعب نسي كلمة المرور'],
  },
  {
    id: 'GENERAL_QUESTION',
    code: 'General Question',
    label: 'General question',
    labelAr: 'سؤال عام',
    points: 2,
    description: 'A general inquiry about a particular question or topic.',
    distinction: 'An information request, not a technical fault and not an abuse report.',
    examples: [
      'Player asked how to join the server',
      'استفسار عن مواعيد الفعاليات',
      'سأل عن طريقة اللعب',
      'general question about the rules',
      'kan bes2al 3an el rules',
    ],
    negativeExamples: ['The game keeps crashing', 'اللعبة بتقفل'],
  },
  {
    id: 'NO_RESPONSE',
    code: 'No Response',
    label: 'No response',
    labelAr: 'لا يوجد رد',
    points: 1,
    description: 'Closed because the player was inactive or failed to respond.',
    distinction: 'The player did not answer / the ticket timed out; not merely "no resolution".',
    examples: [
      'Closed due to player inactivity',
      'اللاعب مردش ومفيش رد',
      'مافيش رد من اللاعب',
      'no response from the player after several hours',
      'mafish rad mn el player',
      'closed for inactivity',
    ],
    negativeExamples: ['Staff did not respond', 'الموظف مردش'],
  },
  {
    id: 'UNBANNED',
    code: 'Unbanned',
    label: 'Unbanned',
    labelAr: 'إلغاء الحظر',
    points: 2,
    description: 'An anti-cheat ban was lifted or the player was unbanned.',
    distinction: 'The ban itself was removed or lifted, not merely an unban request being discussed.',
    examples: [
      'Player was unbanned after anti-cheat review',
      'تم رفع الحظر عن اللاعب',
      'فك البان بعد مراجعة الانتي شيت',
      'ban lifted after appeal',
      'unbanned',
    ],
    negativeExamples: ['Player asked how to appeal a ban', 'اللاعب سأل عن التقديم على فك الحظر'],
  },
  {
    id: 'ANYDESK',
    code: 'AnyDesk',
    label: 'AnyDesk',
    labelAr: 'أني ديسك',
    points: 10,
    description: 'A technical issue was diagnosed and resolved through AnyDesk.',
    distinction:
      'The reason describes the ticket handler resolving the issue via an AnyDesk remote session. Choose the single best-fitting AnyDesk category; never award both ANYDESK and ANYDESK_BY for the same resolution.',
    examples: [
      'Fixed the driver issue through AnyDesk',
      'حليت المشكلة عن طريق AnyDesk',
      'دخلت أني ديسك وصلحت المشكلة',
      'technical issue solved via AnyDesk remote session',
      'anydesk',
    ],
    negativeExamples: ['AnyDesk was mentioned but the player fixed it alone'],
  },
  {
    id: 'ANYDESK_BY',
    code: 'AnyDesk By',
    label: 'AnyDesk by staff',
    labelAr: 'أني ديسك بواسطة موظف',
    points: 5,
    description: 'An issue was resolved through AnyDesk by a staff member (explicitly attributed).',
    distinction:
      'Use when the reason explicitly says the AnyDesk resolution was performed by a staff member / someone else (for example "AnyDesk by X", "بواسطة", "من قبل"). If attribution is not explicit, prefer ANYDESK. Never select both.',
    examples: [
      'Issue resolved via AnyDesk by another staff member',
      'تم حل المشكلة عن طريق أني ديسك بواسطة أحد الموظفين',
      'AnyDesk by support team',
      'anydesk by admin',
    ],
    negativeExamples: ['I used AnyDesk myself', 'استخدمت أني ديسك بنفسي'],
  },
  {
    id: 'ACCOUNT_RECOVERY',
    code: 'Acc-Recovery',
    label: 'Account recovery',
    labelAr: 'استعادة الحساب',
    points: 2,
    description:
      'Account recovery, a website password reset, or recovery of account data.',
    distinction: 'Password/account access recovery, not a game bug or a ban appeal.',
    examples: [
      'Recovered the player’s account after they forgot the password',
      'استعادة الحساب بعد نسيان كلمة المرور',
      'تم تغيير الباسورد واسترجاع الحساب',
      'account recovery and password reset',
      'nset el password w 3mlna recovery',
    ],
    negativeExamples: ['Player wanted a new username', 'اللاعب عايز يغير اسمه'],
  },
  {
    id: 'TEXT_PROBLEM_SOLVED',
    code: 'Problem solved through text',
    label: 'Problem solved through text',
    labelAr: 'تم حل المشكلة بالكتابة',
    points: 5,
    description: 'A problem stated to have been solved through written conversation.',
    distinction:
      'The written closing reason claims the problem was solved through text/chat. No separate transcript proof is required. Do not classify a merely closed ticket or an unresolved complaint as solved.',
    examples: [
      'Problem solved through chatting with the player',
      'تم حل المشكلة عن طريق الشات',
      'المشكلة اتحلت بالكلام مع اللاعب',
      'explained the fix in text and it worked',
      'et7allet bel chat',
    ],
    negativeExamples: ['Player never replied', 'المشكلة لسه موجودة'],
  },
  {
    id: 'RECHARGE',
    code: 'Recharge',
    label: 'Recharge',
    labelAr: 'شحن',
    points: 2,
    description:
      'A recharge or top-up was completed for the player (for example in-game currency, credit, or account balance).',
    distinction:
      'This is a completed recharge/top-up action. It is not account recovery, a password reset, or a general payment question. Do not select it merely because a player asked about recharging.',
    examples: [
      'Recharge completed for the player’s account',
      'تم شحن الحساب للاعب',
      'شحنت اللعبة للاعب وتم الشحن',
      'player top-up completed',
      'tm el shahn lel 7sab',
      'recharge',
    ],
    negativeExamples: [
      'Player asked how to recharge',
      'اللاعب سأل إزاي يشحن',
      'Player forgot his password',
    ],
  },
];

export const TAXONOMY_BY_ID: Record<string, TaxonomyCategory> = Object.fromEntries(
  TAXONOMY.map((category) => [category.id, category]),
) as Record<string, TaxonomyCategory>;

export const CATEGORY_IDS = TAXONOMY.map((category) => category.id) as CategoryId[];

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && (CATEGORY_IDS as string[]).includes(value);
}

export function pointsFor(categoryId: CategoryId, db?: Db): number {
  if (db) {
    const override = db.getCategoryPoints(categoryId);
    if (override !== null) return override;
  }
  return TAXONOMY_BY_ID[categoryId]!.points;
}

export function loadCustomCategories(db: Db): Record<string, TaxonomyCategory> {
  const rows = db.listCustomCategories();
  const result: Record<string, TaxonomyCategory> = {};
  for (const row of rows) {
    result[row.id] = {
      id: row.id,
      code: row.code,
      label: row.label,
      labelAr: row.labelAr,
      description: row.description,
      points: row.points,
      distinction: row.distinction || undefined,
      examples: row.examples,
      negativeExamples: row.negativeExamples.length > 0 ? row.negativeExamples : undefined,
      isCustom: true,
    };
  }
  return result;
}

export function findApprovedReason(db: Db, normalizedText: string): { categoryId: CategoryId; text: string } | null {
  const reasons = db.listApprovedReasons();
  let best: { categoryId: CategoryId; text: string; score: number } | null = null;
  for (const reason of reasons) {
    const score = editSimilarity(normalizedText, reason.normalizedText);
    if (score >= 0.75 && (!best || score > best.score)) {
      best = { categoryId: reason.categoryId, text: reason.text, score };
    }
  }
  return best ? { categoryId: best.categoryId, text: best.text } : null;
}

export const FALLBACK_DISPLAY_LABEL = 'General problem (fallback)';
