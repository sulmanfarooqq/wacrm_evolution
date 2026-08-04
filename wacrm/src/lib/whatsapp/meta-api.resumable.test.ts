import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadResumableMedia } from './meta-api';

describe('uploadResumableMedia', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a clear error — Evolution has no Resumable Upload', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadResumableMedia({
        appId: 'app-1',
        accessToken: 'tok',
        fileName: 'header.jpg',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    ).rejects.toThrow(/Evolution API has no Resumable Upload/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
