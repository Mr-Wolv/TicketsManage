import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, CloudSemanticUnavailableError, buildTaxonomyContext, redactPayload, classifyWithRetry } from '../server/classifier/cloud.js';

describe('cloud semantic provider', () => {
  let provider: OpenAiCompatibleProvider;

  beforeEach(() => {
    provider = new OpenAiCompatibleProvider('https://openrouter.ai/api/v1', 'key', 'model');
  });

  it('throws when provider URL is empty', async () => {
    provider = new OpenAiCompatibleProvider('', 'key', 'model');
    await expect(provider.classify('reason', 'context', 1000)).rejects.toThrow(CloudSemanticUnavailableError);
  });

  it('builds taxonomy context from category list', () => {
    const context = buildTaxonomyContext([
      { id: 'RECHARGE', code: 'RECHARGE', label: 'Recharge', examples: ['shahn'] },
      { id: 'REPORT', code: 'REPORT', label: 'Report', examples: [] },
    ]);
    expect(context).toContain('RECHARGE: Recharge (RECHARGE)');
    expect(context).toContain('examples: shahn');
    expect(context).toContain('REPORT: Report (REPORT)');
  });

  it('redacts Discord user and role mentions', () => {
    const input = 'Please contact <@123456> and <@&789012> about the issue';
    const sanitized = redactPayload(input);
    expect(sanitized).not.toContain('<@');
    expect(sanitized).toContain('[REDACTED_USER]');
    expect(sanitized).toContain('[REDACTED_ROLE]');
  });

  it('truncates long payloads to 500 characters', () => {
    const input = 'a'.repeat(600);
    expect(redactPayload(input)).toHaveLength(500);
  });

  it('marks free-model daily quota errors as non-retryable', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', code: '429' } }), { status: 429, headers: { 'content-type': 'application/json' } }) as Response;
    };

    try {
      await expect(provider.classify('reason', 'context', 1000)).rejects.toThrow('free-models-per-day');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('retries transient 429s without Retry-After', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: '429' } }), { status: 429, headers: { 'content-type': 'application/json' } }) as Response;
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ categories: [{ id: 'REPORT', evidence: ['test'], confidence: 'high' }], review_required: false, explanation: 'ok' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) as Response;
    };

    try {
      const result = await classifyWithRetry(provider, 'reason', 'context', 1000);
      expect(result.categories.map((c) => c.id)).toEqual(['REPORT']);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does not retry non-retryable client errors', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'Bad request', code: '400' } }), { status: 400, headers: { 'content-type': 'application/json' } }) as Response;
    };

    try {
      await expect(provider.classify('reason', 'context', 1000)).rejects.toThrow('400');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
