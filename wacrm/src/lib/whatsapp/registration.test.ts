import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSubscribedApps,
  registerPhoneNumber,
  subscribeWabaToApp,
} from './meta-api';

describe('registerPhoneNumber (Evolution no-op)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves as success without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await registerPhoneNumber({
      phoneNumberId: 'PNID_123',
      accessToken: 'tok',
      pin: '123456',
    });
    expect(result).toEqual({ success: true, alreadyRegistered: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('subscribeWabaToApp (Evolution no-op)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      subscribeWabaToApp({ wabaId: 'WABA_1', accessToken: 'tok' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getSubscribedApps (Evolution no-op)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an empty list without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const apps = await getSubscribedApps({
      wabaId: 'WABA_1',
      accessToken: 'tok',
    });
    expect(apps).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
