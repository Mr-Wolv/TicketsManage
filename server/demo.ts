import type { Db } from './db.js';
import { CLASSIFIER_VERSION, TAXONOMY_VERSION } from './config.js';
import { classifyReason } from './classifier/pipeline.js';
import { applyStaffCredit, basePointsFor } from './scoring.js';
import type { StoredAssessment, TicketMetadata, TranscriptMessage } from './types.js';

const DEMO_BASE = 9_000_000n;

interface DemoFixture {
  offset: number;
  reason: string | null;
  reasonState: 'present' | 'empty';
  opener: string;
  claimed: { name: string; id: string } | null;
  claimedState: 'present' | 'unclaimed' | 'unavailable';
  closer: { name: string; id: string } | null;
  closedState: 'present' | 'unavailable';
  rating: number | null;
  messages: Array<{ author: string; content: string }>;
}

const FIXTURES: DemoFixture[] = [
  {
    offset: 1,
    reason: 'Player kept insulting other players in chat, reported for abuse.',
    reasonState: 'present',
    opener: 'demo_player_1',
    claimed: { name: 'Amina (demo)', id: 'demo-staff-1' },
    claimedState: 'present',
    closer: { name: 'Amina (demo)', id: 'demo-staff-1' },
    closedState: 'present',
    rating: 4,
    messages: [
      { author: 'demo_player_1', content: 'This player keeps swearing at everyone.' },
      { author: 'Amina (demo)', content: 'Thanks, I will review the chat logs.' },
      { author: 'Amina (demo)', content: 'Report handled.' },
    ],
  },
  {
    offset: 2,
    reason: 'تم حل المشكلة عن طريق الشات',
    reasonState: 'present',
    opener: 'demo_player_2',
    claimed: { name: 'Omar (demo)', id: 'demo-staff-2' },
    claimedState: 'present',
    closer: { name: 'Omar (demo)', id: 'demo-staff-2' },
    closedState: 'present',
    rating: 5,
    messages: [
      { author: 'demo_player_2', content: 'عندي مشكلة في اللعبة' },
      { author: 'Omar (demo)', content: 'جرب الخطوات دي وابلغني' },
      { author: 'demo_player_2', content: 'تمام اتحلت، شكراً' },
    ],
  },
  {
    offset: 3,
    reason: 'اللاعب مردش ومفيش رد',
    reasonState: 'present',
    opener: 'demo_player_3',
    claimed: null,
    claimedState: 'unclaimed',
    closer: { name: 'Youssef (demo)', id: 'demo-staff-3' },
    closedState: 'present',
    rating: null,
    messages: [{ author: 'Youssef (demo)', content: 'Player never replied to the follow-up.' }],
  },
  {
    offset: 4,
    reason: 'تم شحن الحساب للاعب',
    reasonState: 'present',
    opener: 'demo_player_4',
    claimed: { name: 'Sara (demo)', id: 'demo-staff-4' },
    claimedState: 'present',
    closer: { name: 'Sara (demo)', id: 'demo-staff-4' },
    closedState: 'present',
    rating: 5,
    messages: [
      { author: 'demo_player_4', content: 'ممكن أشحن الحساب؟' },
      { author: 'Sara (demo)', content: 'تم شحن الحساب بنجاح.' },
    ],
  },
  {
    offset: 5,
    reason: 'تم رفع الحظر بعد المراجعة',
    reasonState: 'present',
    opener: 'demo_player_5',
    claimed: { name: 'Amina (demo)', id: 'demo-staff-1' },
    claimedState: 'present',
    closer: { name: 'Omar (demo)', id: 'demo-staff-2' },
    closedState: 'present',
    rating: 3,
    messages: [{ author: 'Omar (demo)', content: 'Anti-cheat ban reviewed and lifted.' }],
  },
  {
    offset: 6,
    reason: 'zxqv unusual wording blorp',
    reasonState: 'present',
    opener: 'demo_player_6',
    claimed: { name: 'Sara (demo)', id: 'demo-staff-4' },
    claimedState: 'present',
    closer: { name: 'Sara (demo)', id: 'demo-staff-4' },
    closedState: 'present',
    rating: null,
    messages: [{ author: 'Sara (demo)', content: 'Closing with a reason that needs review.' }],
  },
  {
    offset: 7,
    reason: 'Player asked about event times',
    reasonState: 'present',
    opener: 'demo_player_7',
    claimed: null,
    claimedState: 'unavailable',
    closer: { name: 'Youssef (demo)', id: 'demo-staff-3' },
    closedState: 'present',
    rating: null,
    messages: [],
  },
];

export interface DemoSeedResult {
  created: number;
  skipped: number;
  ids: string[];
}

export async function seedDemoData(db: Db): Promise<DemoSeedResult> {
  let created = 0;
  let skipped = 0;
  const ids: string[] = [];
  for (const fixture of FIXTURES) {
    const ticketId = (DEMO_BASE + BigInt(fixture.offset)).toString();
    const existing = db.getTicketRow(ticketId);
    if (existing && Number(existing.is_demo) !== 1) {
      skipped += 1;
      continue;
    }
    if (existing && Number(existing.is_demo) === 1) {
      skipped += 1;
      continue;
    }
    const now = new Date().toISOString();
    const metadata: TicketMetadata = {
      ticketId,
      openerUsername: fixture.opener,
      openerUserId: `demo-opener-${fixture.offset}`,
      openedAt: new Date(Date.now() - fixture.offset * 86_400_000).toISOString(),
      openedAtSource: 'demo',
      claimedByName: fixture.claimed?.name ?? null,
      claimedById: fixture.claimed?.id ?? null,
      claimedState: fixture.claimedState,
      closedByName: fixture.closer?.name ?? null,
      closedById: fixture.closer?.id ?? null,
      closedState: fixture.closedState,
      closedAt: new Date(Date.now() - fixture.offset * 86_000_000).toISOString(),
      closedAtSource: 'demo',
      closeReason: fixture.reason,
      closeReasonState: fixture.reasonState,
      rating: fixture.rating,
      ratingState: fixture.rating === null ? 'unavailable' : 'present',
      ticketUrl: null,
      transcriptState: fixture.messages.length > 0 ? 'available' : 'unavailable',
      labels: ['demo'],
      rawListRow: { demo: true },
    };
    db.upsertTicket(
      { ...metadata, collectionStatus: 'collected', collectionError: null },
      true,
    );
    const messages: TranscriptMessage[] = fixture.messages.map((message, index) => ({
      seq: index,
      messageId: `demo-message-${fixture.offset}-${index}`,
      authorName: message.author,
      authorId: message.author.startsWith('demo-staff') ? message.author : `demo-user-${index}`,
      timestamp: new Date(Date.now() - (fixture.messages.length - index) * 60_000).toISOString(),
      content: message.content,
      embeds: [],
      attachments: [],
      components: [],
    }));
    if (messages.length > 0) db.replaceMessages(ticketId, messages);

    const classification = await classifyReason(fixture.reason ?? '', fixture.reasonState, {
      fuzzyThreshold: 0.82,
      semanticEnabled: false,
      model: null,
      suppressSemanticDisabledReview: true,
    });
    const basePoints = basePointsFor(classification.categories);
    const credit = applyStaffCredit(
      {
        claimedState: fixture.claimedState,
        claimedById: fixture.claimed?.id ?? null,
        claimedByName: fixture.claimed?.name ?? null,
        closedState: fixture.closedState,
        closedById: fixture.closer?.id ?? null,
        closedByName: fixture.closer?.name ?? null,
        reasonState: fixture.reasonState,
      },
      basePoints,
    );
    const reviewReasons = [...classification.reviewReasons];
    if (credit.status === 'unresolved') {
      reviewReasons.push(`Staff attribution unresolved: ${credit.explanation}`);
    }
    const assessment: StoredAssessment = {
      ticketId,
      originalReason: fixture.reason,
      categories: classification.categories,
      basePoints,
      fallback: classification.fallback,
      method: classification.method,
      confidence: classification.confidence,
      explanation: classification.explanation,
      alternatives: classification.alternatives,
      reviewReasons,
      unresolvedPortion: null,
      creditRule: credit.rule,
      creditStatus: credit.status,
      creditStaffId: credit.staffId,
      creditStaffName: credit.staffName,
      awardedPoints: credit.awardedPoints,
      creditExplanation: credit.explanation,
      model: null,
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      humanCorrected: false,
      assessedAt: now,
    };
    db.saveAssessment(assessment);
    if (reviewReasons.length > 0) db.ensureReview(ticketId, reviewReasons);
    ids.push(ticketId);
    created += 1;
  }
  return { created, skipped, ids };
}
