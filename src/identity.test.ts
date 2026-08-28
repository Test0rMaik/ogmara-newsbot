import { describe, expect, it } from 'vitest';
import { MediaError } from './media.js';
import { fetchProfile, uploadAvatar } from './identity.js';

const VALID_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function fakeClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}): any {
  return {
    getUserProfile: async () => ({ user: { address: 'klv1x', public_key: 'pk', registered_at: 0 } }),
    uploadMedia: async () => ({ cid: 'bafy-avatar', size: VALID_PNG.byteLength }),
    updateProfile: async () => {},
    ...overrides,
  };
}

describe('fetchProfile', () => {
  it('maps display_name/bio/avatar_cid onto the ProfileSpec shape', async () => {
    const client = fakeClient({
      getUserProfile: async () => ({
        user: {
          address: 'klv1x',
          public_key: 'pk',
          registered_at: 0,
          display_name: 'My Bot',
          bio: 'Automated posts',
          avatar_cid: 'bafy123',
        },
      }),
    });
    const profile = await fetchProfile(client, 'klv1x');
    expect(profile).toEqual({ displayName: 'My Bot', bio: 'Automated posts', avatarCid: 'bafy123' });
  });

  it('omits fields the node never returns, rather than setting them to undefined explicitly', async () => {
    const client = fakeClient();
    const profile = await fetchProfile(client, 'klv1x');
    expect(profile).toEqual({});
    expect('displayName' in profile).toBe(false);
  });
});

describe('uploadAvatar', () => {
  it('uploads the image, then sets it as the avatar via updateProfile', async () => {
    let uploadedFilename = '';
    let updatedWith: unknown;
    const client = fakeClient({
      uploadMedia: async (_blob: Blob, filename: string) => {
        uploadedFilename = filename;
        return { cid: 'bafy-avatar', size: VALID_PNG.byteLength };
      },
      updateProfile: async (data: unknown) => {
        updatedWith = data;
      },
    });
    const result = await uploadAvatar(client, VALID_PNG, 'image/png', 'me.png');
    expect(result).toEqual({ avatarCid: 'bafy-avatar' });
    expect(uploadedFilename).toBe('me.png');
    expect(updatedWith).toEqual({ avatar_cid: 'bafy-avatar' });
  });

  it('rejects bytes that do not match the claimed image type before ever calling uploadMedia', async () => {
    let called = false;
    const client = fakeClient({
      uploadMedia: async () => {
        called = true;
        return { cid: 'x', size: 0 };
      },
    });
    await expect(uploadAvatar(client, new Uint8Array([1, 2, 3]), 'image/png', 'fake.png')).rejects.toThrow(
      MediaError,
    );
    expect(called).toBe(false);
  });

  it('rejects a disallowed MIME type (e.g. SVG) the same way the RSS-image path does', async () => {
    await expect(
      uploadAvatar(fakeClient(), new Uint8Array([1, 2, 3]), 'image/svg+xml', 'x.svg'),
    ).rejects.toThrow(/unsupported MIME type/);
  });

  it('never calls updateProfile if the upload itself fails', async () => {
    let profileUpdated = false;
    const client = fakeClient({
      uploadMedia: async () => {
        throw new Error('request failed: 503');
      },
      updateProfile: async () => {
        profileUpdated = true;
      },
    });
    await expect(uploadAvatar(client, VALID_PNG, 'image/png', 'me.png')).rejects.toThrow(MediaError);
    expect(profileUpdated).toBe(false);
  });
});
