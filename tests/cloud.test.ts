import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, CloudSemanticUnavailableError, buildTaxonomyContext, redactPayload } from '../server/classifier/cloud.js';

describe('cloud semantic provider', () => {
  let provider: OpenAiCompatibleProvider;

  beforeEach(() => {
    provider = new OpenAiCompatibleProvider('http://127.0.0.1:1', 'key', 'model');
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
});
