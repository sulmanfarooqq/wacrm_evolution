import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEvolutionWebhook } from './meta-api';

// The v2 /webhook/set endpoint requires the `webhook` wrapper object with
// `enabled`/`url`/`byEvents`/`base64`/`events` — the v1 flat snake_case
// form is rejected with 400 "Bad Request".

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let captured: Captured | null = null;

describe('setEvolutionWebhook', () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        captured = {
          url,
          headers: (init?.headers as Record<string, string>) ?? {},
          body: init?.body ? JSON.parse(init.body as string) : {},
        };
        return {
          ok: true,
          status: 201,
          json: async () => ({ webhook: {} }),
        } as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the v2 `webhook` wrapper body with default events', async () => {
    await setEvolutionWebhook({
      instanceName: 'test1',
      apiKey: 'tok',
      url: 'https://app.example.com/api/whatsapp/webhook',
    });

    expect(captured?.url).toContain('webhook/set/test1');
    expect(captured?.headers.apikey).toBe('tok');
    expect(captured?.body).toEqual({
      webhook: {
        enabled: true,
        url: 'https://app.example.com/api/whatsapp/webhook',
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
      },
    });
  });

  it('uses the provided events list when given', async () => {
    await setEvolutionWebhook({
      instanceName: 'test1',
      apiKey: 'tok',
      url: 'https://app.example.com/hook',
      events: ['MESSAGES_UPSERT'],
    });

    expect(captured?.body).toEqual({
      webhook: {
        enabled: true,
        url: 'https://app.example.com/hook',
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT'],
      },
    });
  });
});
