import type { CategoryAssessment, ClassificationResult } from '../types.js';
import type { CategoryId } from '../types.js';

export interface CloudSemanticProvider {
  readonly name: string;
  classify(reason: string, taxonomyContext: string, timeoutMs: number): Promise<CloudSemanticResult>;
}

export interface CloudSemanticResult {
  categories: Array<{ id: string; evidence: string[]; confidence: 'high' | 'medium' | 'low' }>;
  alternative_categories: Array<{ id: string; reason: string }>;
  category?: string;
  alternative_category?: string;
  unresolved_portion: string | null;
  review_required: boolean;
  explanation: string;
  model: string;
  latencyMs: number;
}

export interface CloudSemanticSettings {
  enabled: boolean;
  providerUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  mode: 'deterministic' | 'shadow' | 'production';
}

export const DEFAULT_CLOUD_SETTINGS: CloudSemanticSettings = {
  enabled: false,
  providerUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: 15000,
  mode: 'deterministic',
};

export function buildTaxonomyContext(taxonomy: Array<{ id: string; code: string; label: string; examples: string[] }>): string {
  const lines = taxonomy.map((item) => `${item.id}: ${item.label} (${item.code})` + (item.examples.length ? ` examples: ${item.examples.join(', ')}` : ''));
  return `Categories:\n${lines.join('\n')}`;
}

export function redactPayload(raw: string): string {
  const sanitized = raw.replace(/<@!?\d+>/g, '[REDACTED_USER]').replace(/<@&\d+>/g, '[REDACTED_ROLE]');
  return sanitized.slice(0, 500);
}

export class CloudSemanticUnavailableError extends Error {
  constructor(public readonly cause: string, public readonly quotaExhausted = false, public readonly quotaReason = '') {
    super(`Cloud semantic unavailable: ${cause}`);
    this.name = 'CloudSemanticUnavailableError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function classifyWithRetry(
  provider: OpenAiCompatibleProvider,
  reason: string,
  taxonomyContext: string,
  timeoutMs: number,
  maxRetries = 3,
): Promise<CloudSemanticResult> {
  let attempt = 0;
  let backoffMs = 500;
  let lastError: Error | undefined;

  while (attempt < maxRetries) {
    try {
      return await provider.classify(reason, taxonomyContext, timeoutMs);
    } catch (error) {
      lastError = error as Error;
      const typed = lastError as CloudSemanticUnavailableError & { status?: number; retryAfterMs?: number };
      if (typed.quotaExhausted) {
        throw lastError;
      }
      const status = typed.status;
      const retryAfter = typed.retryAfterMs;
      if (status !== undefined && status !== 429 && (status < 500 || status >= 600)) {
        throw lastError;
      }
      attempt += 1;
      if (attempt >= maxRetries) break;
      await sleep(retryAfter ?? backoffMs);
      backoffMs = Math.min(backoffMs * 2, 8000);
    }
  }
  throw lastError ?? new CloudSemanticUnavailableError('Unknown provider error');
}

export class OpenAiCompatibleProvider implements CloudSemanticProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly providerUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async classify(reason: string, taxonomyContext: string, timeoutMs: number): Promise<CloudSemanticResult> {
    if (!this.providerUrl || !this.apiKey || !this.model) {
      throw new CloudSemanticUnavailableError('Provider is not configured.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const systemPrompt = `You are a support ticket classifier. Return JSON only matching this exact schema: {"categories": [{"id": "CATEGORY_ID", "evidence": ["phrase from reason"], "confidence": "high"}], "alternative_categories": [{"id": "ALT_ID", "reason": "why considered"}], "unresolved_portion": null, "review_required": false, "explanation": "why this category"}. Use only the provided category IDs. ${taxonomyContext}`;

    try {
      const baseUrl = this.providerUrl.replace(/\/+$/, '').replace(/\/v1\/?$/, '');
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `<reason>\n${redactPayload(reason)}\n</reason>` },
          ],
          max_tokens: 300,
          temperature: 0,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        const retryAfterMs = response.headers.get('retry-after');
        let error = new CloudSemanticUnavailableError(`Provider responded ${response.status}: ${text.slice(0, 200)}`) as CloudSemanticUnavailableError & { status: number; retryAfterMs?: number };
        error.status = response.status;
        if (retryAfterMs) {
          const parsed = Number(retryAfterMs);
          if (!Number.isNaN(parsed)) error.retryAfterMs = parsed * 1000;
        }
        if (response.status === 429 && /free-models-per-day/.test(text)) {
          error = new CloudSemanticUnavailableError(
            `OpenRouter daily free-model quota exhausted: ${text.slice(0, 200)}`,
            true,
            text.slice(0, 200),
          ) as CloudSemanticUnavailableError & { status: number; retryAfterMs?: number };
          error.status = response.status;
          if (retryAfterMs) {
            const parsed = Number(retryAfterMs);
            if (!Number.isNaN(parsed)) error.retryAfterMs = parsed * 1000;
          }
        }
        throw error;
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const content = choices[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new CloudSemanticUnavailableError('Provider returned an empty response.');
      }

      const parsed = JSON.parse(content) as Record<string, unknown>;
      const categories = Array.isArray(parsed.categories)
        ? (parsed.categories as Array<{ id: string; evidence?: string[]; confidence?: 'high' | 'medium' | 'low' }>)
        : typeof parsed.category === 'string'
          ? [{ id: parsed.category, evidence: [], confidence: 'medium' as const }]
          : [];
      const alternative_categories = Array.isArray(parsed.alternative_categories)
        ? (parsed.alternative_categories as Array<{ id: string; reason?: string }>)
        : typeof parsed.alternative_category === 'string'
          ? [{ id: parsed.alternative_category, reason: '' }]
          : [];

      return {
        categories,
        alternative_categories,
        unresolved_portion: typeof parsed.unresolved_portion === 'string' ? parsed.unresolved_portion : null,
        review_required: typeof parsed.review_required === 'boolean' ? parsed.review_required : false,
        explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
        model: this.model,
        latencyMs: 0,
      } as CloudSemanticResult;
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof CloudSemanticUnavailableError) {
        throw error;
      }
      if ((error as Error)?.name === 'AbortError') {
        throw new CloudSemanticUnavailableError('Request timed out.');
      }
      throw new CloudSemanticUnavailableError((error as Error)?.message ?? 'Unknown provider error');
    }
  }
}

export function adaptCloudResult(result: CloudSemanticResult): Record<string, unknown> {
  const categories = Array.isArray(result.categories)
    ? result.categories
    : result.category
      ? [{ id: result.category, evidence: [], confidence: 'medium' }]
      : [];
  const alternatives = Array.isArray(result.alternative_categories)
    ? result.alternative_categories
    : result.alternative_category
      ? [{ id: result.alternative_category, reason: '' }]
      : [];
  return {
    categories: categories.map((category) => ({
      categoryId: category.id,
      evidence: category.evidence,
      confidence: category.confidence,
    })),
    alternatives: alternatives.map((category) => ({
      categoryId: category.id,
      reason: category.reason,
    })),
    unresolvedPortion: result.unresolved_portion,
    reviewRequired: result.review_required,
    explanation: result.explanation,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
