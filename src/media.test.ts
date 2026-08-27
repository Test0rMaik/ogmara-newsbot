import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaError, uploadImage, uploadImageBytes, validateImageBytesOnly, validateImageOnly } from './media.js';

/**
 * `checkImageBytes` is the one real validator behind all four public
 * functions here (path-based and bytes-based, upload and dry-run-validate)
 * since the refactor that added the bytes-based pair for downloaded feed
 * images. These tests exercise it through every entry point rather than only
 * the newest one, so the refactor itself is the thing under test, not just
 * the new code.
 *
 * Fixtures use REAL minimal magic-number-valid bytes for each format —
 * required since the security audit found the pre-fix validator trusted a
 * claimed MIME type outright, letting a hostile feed server label arbitrary
 * bytes (or a script-capable SVG) as `image/png` and have them published
 * under the operator's wallet. `checkImageBytes` now verifies the bytes
 * actually match the claimed type's signature, so a fixture claiming
 * `image/jpeg` has to actually start with the JPEG magic number or every
 * test below would be validating the wrong thing.
 */

const VALID_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 1, 2, 3, 4]);
const VALID_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const VALID_GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const VALID_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-media-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeClient(uploadMedia: (blob: Blob, filename: string) => Promise<unknown>): any {
  return { uploadMedia };
}

describe('validateImageBytesOnly', () => {
  it('returns a dry-run placeholder attachment for valid bytes', () => {
    const attachment = validateImageBytesOnly(VALID_JPEG, 'pic.jpg', 'image/jpeg', 1024);
    expect(attachment.cid).toBe('dry-run-not-uploaded');
    expect(attachment.mime_type).toBe('image/jpeg');
    expect(attachment.size_bytes).toBe(VALID_JPEG.byteLength);
    expect(attachment.filename).toBe('pic.jpg');
  });

  it('accepts real png/gif/webp signatures too, not just jpeg', () => {
    expect(() => validateImageBytesOnly(VALID_PNG, 'p.png', 'image/png', 1024)).not.toThrow();
    expect(() => validateImageBytesOnly(VALID_GIF, 'g.gif', 'image/gif', 1024)).not.toThrow();
    expect(() => validateImageBytesOnly(VALID_WEBP, 'w.webp', 'image/webp', 1024)).not.toThrow();
  });

  it('rejects empty bytes', () => {
    expect(() => validateImageBytesOnly(new Uint8Array(0), 'pic.jpg', 'image/jpeg', 1024)).toThrow(
      MediaError,
    );
  });

  it('rejects bytes over the limit', () => {
    expect(() =>
      validateImageBytesOnly(VALID_JPEG.slice(0, 2), 'pic.jpg', 'image/jpeg', 1),
    ).toThrow(/over the/);
  });

  it('rejects a non-image MIME type', () => {
    expect(() => validateImageBytesOnly(new Uint8Array([1]), 'clip.mp4', 'video/mp4', 1024)).toThrow(
      /unsupported MIME type/,
    );
  });

  it('rejects a MIME type outside the four-format allowlist even if it starts with "image/"', () => {
    // The pre-fix check was `mimeType.startsWith('image/')`, which let
    // image/svg+xml (script-capable) and anything else "image/*" through.
    expect(() =>
      validateImageBytesOnly(new Uint8Array([1, 2, 3]), 'x.svg', 'image/svg+xml', 1024),
    ).toThrow(/unsupported MIME type/);
    expect(() =>
      validateImageBytesOnly(new Uint8Array([1, 2, 3]), 'x.bmp', 'image/bmp', 1024),
    ).toThrow(/unsupported MIME type/);
  });

  it('rejects bytes whose signature does not match the claimed MIME type — closes content-laundering', () => {
    // The core security fix: a remote server can put ANY Content-Type header
    // on a response, including on bytes that are not really an image at
    // all. The claim alone must never be enough.
    const notAnImage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => validateImageBytesOnly(notAnImage, 'x.jpg', 'image/jpeg', 1024)).toThrow(
      /does not look like a real image\/jpeg file/,
    );
    // A real PNG mislabeled as a JPEG is rejected too, not just random bytes.
    expect(() => validateImageBytesOnly(VALID_PNG, 'x.jpg', 'image/jpeg', 1024)).toThrow(
      /does not look like a real image\/jpeg file/,
    );
  });
});

describe('uploadImageBytes', () => {
  it('uploads and returns the node-assigned CID', async () => {
    const client = fakeClient(async (blob, filename) => {
      expect(filename).toBe('feed-image.jpg');
      expect(blob.type).toBe('image/jpeg');
      return { cid: 'bafy-real-cid', size: VALID_JPEG.byteLength };
    });
    const attachment = await uploadImageBytes(client, VALID_JPEG, 'feed-image.jpg', 'image/jpeg', 1024);
    expect(attachment.cid).toBe('bafy-real-cid');
    expect(attachment.filename).toBe('feed-image.jpg');
  });

  it('includes thumbnail_cid when the node returns one', async () => {
    const client = fakeClient(async () => ({ cid: 'c1', size: VALID_PNG.byteLength, thumbnail_cid: 'thumb1' }));
    const attachment = await uploadImageBytes(client, VALID_PNG, 'x.png', 'image/png', 1024);
    expect(attachment.thumbnail_cid).toBe('thumb1');
  });

  it('never reaches the network for bytes that fail validation', async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return { cid: 'x', size: 0 };
    });
    await expect(
      uploadImageBytes(client, new Uint8Array(0), 'empty.jpg', 'image/jpeg', 1024),
    ).rejects.toThrow(MediaError);
    expect(called).toBe(false);
  });

  it('never reaches the network when the signature does not match the claim', async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return { cid: 'x', size: 8 };
    });
    await expect(
      uploadImageBytes(client, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'x.jpg', 'image/jpeg', 1024),
    ).rejects.toThrow(MediaError);
    expect(called).toBe(false);
  });

  it('translates a 503 from the node into an operator-facing IPFS-offline message', async () => {
    const client = fakeClient(async () => {
      throw new Error('request failed: 503 Service Unavailable');
    });
    await expect(uploadImageBytes(client, VALID_JPEG, 'x.jpg', 'image/jpeg', 1024)).rejects.toThrow(
      /IPFS backend offline/,
    );
  });

  it('wraps any other upload failure with the filename for context', async () => {
    const client = fakeClient(async () => {
      throw new Error('network reset');
    });
    await expect(uploadImageBytes(client, VALID_JPEG, 'x.jpg', 'image/jpeg', 1024)).rejects.toThrow(
      /upload of "x.jpg" failed: network reset/,
    );
  });
});

describe('path-based validateImageOnly / uploadImage (regression, post-refactor)', () => {
  it('validateImageOnly reads the file and reports its real size', async () => {
    const path = join(dir, 'photo.png');
    writeFileSync(path, Buffer.from(VALID_PNG));
    const attachment = await validateImageOnly(path, 'image/png', 1024);
    expect(attachment.size_bytes).toBe(VALID_PNG.byteLength);
    expect(attachment.filename).toBe('photo.png');
  });

  it('validateImageOnly surfaces an unreadable path as a MediaError, not a raw fs error', async () => {
    await expect(validateImageOnly(join(dir, 'missing.png'), 'image/png', 1024)).rejects.toThrow(
      MediaError,
    );
  });

  it('validateImageOnly still rejects a local file whose bytes disagree with its extension', async () => {
    // imagedir.ts derives mimeType from the file EXTENSION, not content — a
    // renamed non-image file previously would have passed straight through.
    const path = join(dir, 'not-really.png');
    writeFileSync(path, Buffer.from('this is plain text, not a png'));
    await expect(validateImageOnly(path, 'image/png', 1024)).rejects.toThrow(
      /does not look like a real image\/png file/,
    );
  });

  it('uploadImage reads the file and uploads its real bytes', async () => {
    const path = join(dir, 'photo.jpg');
    writeFileSync(path, Buffer.from(VALID_JPEG));
    let uploadedSize = -1;
    const client = fakeClient(async (blob) => {
      uploadedSize = blob.size;
      return { cid: 'c', size: blob.size };
    });
    await uploadImage(client, path, 'image/jpeg', 1024);
    expect(uploadedSize).toBe(VALID_JPEG.byteLength);
  });
});
