import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteMessageTemplate,
  editMessageTemplate,
  submitMessageTemplate,
} from './meta-api';

// With Evolution there is no Meta approval flow — these helpers are
// local-only stubs. The contract we care about is that they succeed
// locally WITHOUT touching the network.

describe('submitMessageTemplate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a synthetic local id with APPROVED status without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitMessageTemplate({
      wabaId: 'WABA1',
      accessToken: 'tok',
      payload: {
        name: 't',
        category: 'UTILITY',
        language: 'en_US',
        components: [{ type: 'BODY', text: 'hi' }],
      },
    });

    expect(result.id).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(result.status).toBe('APPROVED');
    expect(result.category).toBe('UTILITY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('editMessageTemplate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      editMessageTemplate({
        metaTemplateId: 'TMPL_42',
        accessToken: 'tok',
        components: [{ type: 'BODY', text: 'new body' }],
      }),
    ).resolves.toEqual({ success: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteMessageTemplate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      deleteMessageTemplate({
        wabaId: 'W',
        accessToken: 't',
        name: 'order_confirmation',
        metaTemplateId: '12345',
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
