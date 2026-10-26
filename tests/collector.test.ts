import { describe, expect, it } from 'vitest';
import { inferClaim, parseDashboardJson, parseRetryAfter } from '../server/collector.js';
import type { TranscriptMessage } from '../server/types.js';

function message(patch: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    seq: 0,
    messageId: null,
    authorName: 'Tickets v2',
    authorId: '1325579039888511056',
    timestamp: null,
    content: '',
    embeds: [],
    attachments: [],
    components: [],
    ...patch,
  };
}

describe('dashboard JSON parsing', () => {
  it('keeps unsafe Discord IDs exact instead of rounding them', () => {
    const parsed = parseDashboardJson(
      '{"transcripts":[{"ticket_id":7770,"closed_by":752978053101256744}]}',
    ) as { transcripts: Array<{ ticket_id: number; closed_by: unknown }> };
    expect(parsed.transcripts[0]?.closed_by).toBe('752978053101256744');
    expect(parsed.transcripts[0]?.ticket_id).toBe(7770);
  });

  it('does not alter digits inside strings, decimals, exponents or timestamps', () => {
    const parsed = parseDashboardJson(
      '{"note":"id 752978053101256744","ratio":1.25,"exp":1e3,"time":1792858264767}',
    ) as Record<string, unknown>;
    expect(parsed.note).toBe('id 752978053101256744');
    expect(parsed.ratio).toBe(1.25);
    expect(parsed.exp).toBe(1000);
    expect(parsed.time).toBe(1792858264767);
  });
});

describe('dashboard rate-limit hints', () => {
  const response = (headers: Record<string, string>) => ({ headers: () => headers });

  it('accepts delta-seconds and HTTP-date Retry-After values', () => {
    expect(parseRetryAfter(response({ 'retry-after': '45' }))).toBe(45);
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfter(response({ 'retry-after': future }));
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(25);
    expect(parsed!).toBeLessThanOrEqual(30);
  });

  it('returns null for missing or unusable hints instead of sleeping forever', () => {
    expect(parseRetryAfter(response({}))).toBeNull();
    expect(parseRetryAfter(response({ 'retry-after': 'later' }))).toBeNull();
  });
});

describe('claimant inference from the transcript', () => {
  const users = new Map([
    ['752978053101256744', 'b932'],
  ]);

  it('uses the claimed-ticket control message and resolves the staff name', () => {
    const claim = inferClaim(
      [
        message({
          embeds: [
            {
              title: 'Claimed Ticket',
              description: 'Your ticket will be handled by <@752978053101256744>',
            },
          ],
        }),
      ],
      users,
    );
    expect(claim.state).toBe('present');
    expect(claim.id).toBe('752978053101256744');
    expect(claim.name).toBe('b932');
  });

  it('honours the latest claim or unclaim event', () => {
    const claim = inferClaim(
      [
        message({
          embeds: [
            {
              title: 'Claimed Ticket',
              description: 'Your ticket will be handled by <@752978053101256744>',
            },
          ],
        }),
        message({ embeds: [{ title: 'Unclaimed Ticket', description: 'Ticket unclaimed' }] }),
      ],
      users,
    );
    expect(claim.state).toBe('unclaimed');
    expect(claim.id).toBeNull();
  });

  it('treats an available Claim button as explicit evidence of no claimant', () => {
    const claim = inferClaim(
      [
        message({
          components: [
            {
              type: 1,
              components: [{ type: 2, label: 'Claim', custom_id: 'claim' }],
            },
          ],
        }),
      ],
      users,
    );
    expect(claim.state).toBe('unclaimed');
  });

  it('does not guess when the transcript has no claim evidence', () => {
    const claim = inferClaim([message({ content: 'hello' })], users);
    expect(claim.state).toBe('unavailable');
  });
});
