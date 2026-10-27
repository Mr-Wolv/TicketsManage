export type CategoryId =
  | 'REPORT'
  | 'GENERAL_ISSUE'
  | 'GENERAL_QUESTION'
  | 'NO_RESPONSE'
  | 'UNBANNED'
  | 'ANYDESK'
  | 'ANYDESK_BY'
  | 'ACCOUNT_RECOVERY'
  | 'TEXT_PROBLEM_SOLVED'
  | 'RECHARGE';

export type CollectionStatus =
  | 'collected'
  | 'no_transcript'
  | 'not_found'
  | 'partial'
  | 'failed';

export type FieldState = 'present' | 'unclaimed' | 'unavailable';
export type ReasonState = 'present' | 'empty' | 'unavailable';
export type TranscriptState = 'available' | 'unavailable' | 'restricted' | 'not_retrieved';
export type ReviewStatus = 'pending' | 'accepted' | 'corrected' | 'dismissed';
export type CreditRule = 'A' | 'B' | 'C' | 'D' | 'E' | 'NONE';
export type CreditStatus = 'awarded' | 'zero_different' | 'none' | 'unresolved';
export type ClassificationMethod =
  | 'none'
  | 'approved_alias'
  | 'approved_reason'
  | 'exact'
  | 'fuzzy'
  | 'semantic'
  | 'hybrid'
  | 'cloud'
  | 'rules_only'
  | 'human'
  | 'fallback'
  | 'custom';

export type ConnectionState =
  | 'not_connected'
  | 'browser_starting'
  | 'waiting_for_signin'
  | 'authenticated'
  | 'session_expired'
  | 'access_denied'
  | 'dashboard_unavailable'
  | 'unexpected_page'
  | 'data_unavailable';

export interface ConnectionStatus {
  state: ConnectionState;
  message: string;
  browserOpen: boolean;
  profileExists: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
  dashboardUrl: string;
  observedUrl: string | null;
}

export interface CategoryAssessment {
  categoryId: CategoryId;
  points: number;
  evidence: string[];
  method: ClassificationMethod;
  confidence: number | null;
}

export interface AlternativeCategory {
  categoryId: CategoryId;
  reason: string;
  source: 'rules' | 'model' | 'reconciliation';
}

export interface ClassificationResult {
  categories: CategoryAssessment[];
  fallback: boolean;
  fallbackDisplayLabel: string | null;
  method: ClassificationMethod;
  confidence: number | null;
  explanation: string;
  alternatives: AlternativeCategory[];
  reviewRequired: boolean;
  reviewReasons: string[];
  unresolvedPortion: string | null;
  model: string | null;
  rawReason: string;
  normalizedReason: string;
  reasonState: ReasonState;
}

export interface StaffCreditResult {
  rule: CreditRule;
  status: CreditStatus;
  awardedPoints: number | null;
  staffId: string | null;
  staffName: string | null;
  explanation: string;
}

export interface TicketMetadata {
  ticketId: string;
  openerUsername: string | null;
  openerUserId: string | null;
  openedAt: string | null;
  openedAtSource: string | null;
  claimedByName: string | null;
  claimedById: string | null;
  claimedState: FieldState;
  closedByName: string | null;
  closedById: string | null;
  closedState: FieldState;
  closedAt: string | null;
  closedAtSource: string | null;
  closeReason: string | null;
  closeReasonState: ReasonState;
  rating: number | null;
  ratingState: 'present' | 'unavailable';
  ticketUrl: string | null;
  transcriptState: TranscriptState;
  labels: string[];
  rawListRow: unknown;
}

export interface TranscriptMessage {
  seq: number;
  messageId: string | null;
  authorName: string | null;
  authorId: string | null;
  timestamp: string | null;
  content: string;
  embeds: unknown[];
  attachments: unknown[];
  components: unknown[];
}

export interface TicketRecord extends TicketMetadata {
  collectionStatus: CollectionStatus;
  collectionError: string | null;
  collectedAt: string;
  updatedAt: string;
  isDemo: boolean;
  messages: TranscriptMessage[];
  messageCount: number;
  /**
   * Timestamp of the last transcript message. The dashboard exposes no closure
   * timestamp, so this is the closest evidence of when a ticket stopped being
   * active. It is an upper bound on the close event, never labelled closedAt.
   */
  lastActivityAt: string | null;
  assessment: StoredAssessment | null;
  review: ReviewRecord | null;
}

export interface StoredAssessment {
  ticketId: string;
  originalReason: string | null;
  categories: CategoryAssessment[];
  basePoints: number;
  fallback: boolean;
  method: ClassificationMethod;
  confidence: number | null;
  explanation: string;
  alternatives: AlternativeCategory[];
  reviewReasons: string[];
  unresolvedPortion: string | null;
  creditRule: CreditRule;
  creditStatus: CreditStatus;
  creditStaffId: string | null;
  creditStaffName: string | null;
  awardedPoints: number | null;
  creditExplanation: string;
  model: string | null;
  taxonomyVersion: string;
  classifierVersion: string;
  humanCorrected: boolean;
  assessedAt: string;
}

export interface ReviewRecord {
  ticketId: string;
  status: ReviewStatus;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface CollectionRunRecord {
  id: string;
  startId: string;
  endId: string;
  mode: 'incremental' | 'full';
  status: 'running' | 'paused' | 'cancelled' | 'completed' | 'completed_with_errors' | 'failed';
  requestedCount: number;
  processed: number;
  collected: number;
  partial: number;
  noTranscript: number;
  notFound: number;
  failed: number;
  classified: number;
  fallbacks: number;
  classificationEnabled: boolean;
  stage: string;
  currentTicketId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  lastUpdatedAt: string;
}

export interface CollectionRunDiagnostics {
  mode: 'incremental' | 'full';
  timings: Record<string, number>;
  counts: {
    reused: number;
    fetchedTranscripts: number;
    directRequests: number;
    navigationRequests: number;
    listingPages: number;
    modelCalls: number;
    retries: number;
    failures: number;
    notFound: number;
  };
  perTicket: {
    count: number;
    averageMs: number;
    medianMs: number;
    p95Ms: number;
    maxMs: number;
  };
  /** Internal working sample set; stripped before persisting. */
  perTicketSamples?: number[];
  notes: string[];
  updatedAt: string;
}

export interface AssessmentInput {
  metadata: TicketMetadata;
  messages: TranscriptMessage[];
}

export interface AppSettings {
  dashboardUrl: string;
  guildId: string;
  ollamaUrl: string;
  model: string;
  modelTimeoutMs: number;
  semanticEnabled: boolean;
  /** AI classification mode: deterministic | shadow | production */
  aiMode?: 'deterministic' | 'shadow' | 'production';
  fuzzyThreshold: number;
  requestDelayMs: number;
  classificationEnabled: boolean;
  autoReuseSession: boolean;
  maxRetries: number;
  navigationTimeoutMs: number;
  /** Bounded parallel transcript reads. Network overlap only; writes stay serial. */
  fetchConcurrency: number;
  cloudProviderUrl: string;
  cloudApiKey: string;
  cloudModel: string;
  cloudTimeoutMs: number;
  cloudMaxWorkers: number;
}

export interface ApprovedReason {
  id: number;
  text: string;
  normalizedText: string;
  categoryId: CategoryId;
  sourceType: string;
  sourceTicketId: string | null;
  active: number;
  createdAt: string;
}

export interface TaxonomyOverride {
  categoryId: CategoryId;
  points: number;
  note: string;
  changedAt: string;
}

export interface CustomCategory {
  id: string;
  code: string;
  label: string;
  labelAr: string;
  description: string;
  points: number;
  distinction: string;
  examples: string[];
  negativeExamples: string[];
  active: number;
  createdAt: string;
}

export interface TaxonomyAuditEntry {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: string | null;
  newValue: string | null;
  note: string;
  changedAt: string;
}
