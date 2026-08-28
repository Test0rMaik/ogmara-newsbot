/**
 * Media upload — putting an image on IPFS through the node so a post can
 * reference it.
 *
 * Two node-side facts drive the checks here, because failing before the
 * upload is much cheaper than failing during one:
 *
 * - Media capability is a **live** signal, not a static config flag. A node can
 *   be configured for IPFS with the daemon down, so `/api/v1/health` reports
 *   `media_uploads` per-request and the bot must consult it rather than assume.
 * - The node enforces a MIME allowlist (`image/`, `video/`, `audio/`,
 *   `application/pdf`, `text/plain`) and a size cap (50 MB by default).
 *
 * This module's own allowlist is deliberately **narrower** than the node's:
 * exactly the four raster types `imagedir.ts` already supports
 * (jpeg/png/gif/webp), verified against the bytes' real magic-number
 * signature — not just trusted from a claimed MIME type. That distinction
 * matters more since RSS feed images were added: for `imagedir` the claimed
 * type comes from a file extension the operator chose, but for a
 * feed-downloaded image it comes from a `Content-Type` header the remote
 * server itself writes — an attacker's own server can label anything
 * `image/png` and have it published, signed with the operator's wallet, to
 * an unretractable public feed. Verifying the signature closes that;
 * excluding `image/svg+xml` in particular closes a stored-XSS vector (SVG is
 * script-capable). (Security audit, 0.11.0.)
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Attachment, OgmaraClient } from '@ogmara/sdk';

/**
 * Raised when an image cannot be uploaded.
 *
 * `kind` distinguishes two genuinely different situations a caller mapping
 * this to an HTTP status needs to tell apart: `'input'` means the bytes/type/
 * size themselves are the problem (a 400-class response is correct —
 * something the operator must fix by choosing a different file); `'unavailable'`
 * means the NODE or network is the problem (IPFS backend down, connection
 * failure — a 502-class response is correct, since nothing about the request
 * itself was wrong). Defaults to `'input'` since most throw sites in this
 * module are validation checks; the two throw sites inside `performUpload`'s
 * catch block explicitly pass `'unavailable'`. Getting this wrong previously
 * meant the panel's avatar-upload route reported "your request was
 * malformed" (400) for a plain IPFS outage. (Code audit, 0.14.0.)
 */
export class MediaError extends Error {
  override readonly name = 'MediaError';
  readonly kind: 'input' | 'unavailable';

  constructor(message: string, kind: 'input' | 'unavailable' = 'input') {
    super(message);
    this.kind = kind;
  }
}

/**
 * The node's default upload cap, in bytes.
 *
 * Mirrors `ipfs.max_upload_size_mb` in the node's `ogmara.toml`. Not exposed
 * over the API, so the bot's own limit is configured separately and should be
 * kept at or below whatever the node actually allows.
 */
export const NODE_DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * The only MIME types this bot will ever attach — matches `imagedir.ts`'s
 * extension map exactly, so a local file and a downloaded feed image go
 * through the identical gate.
 */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Whether `bytes` actually begins with the magic number for `mimeType`.
 * Signature-checked rather than trusted from the claim itself — the whole
 * point of this function.
 */
function matchesMagicBytes(bytes: Uint8Array, mimeType: string): boolean {
  const b = bytes;
  switch (mimeType) {
    case 'image/jpeg':
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return (
        b.length >= 8 &&
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
      );
    case 'image/gif':
      return (
        b.length >= 6 &&
        b[0] === 0x47 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x38 &&
        (b[4] === 0x37 || b[4] === 0x39) &&
        b[5] === 0x61
      );
    case 'image/webp':
      return (
        b.length >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
      );
    default:
      return false;
  }
}

/**
 * Run every check {@link uploadImage} does, but skip the network write.
 *
 * Used by dry run so the image path is exercised end to end — unreadable file,
 * wrong type, oversized — without pinning bytes to IPFS for a post that will
 * never exist. The returned CID is a placeholder and must never be published;
 * `publish()` short-circuits on dry run before it could be.
 */
export async function validateImageOnly(
  path: string,
  mimeType: string,
  maxBytes: number,
): Promise<Attachment> {
  const bytes = checkImage(path, mimeType, maxBytes);
  return placeholderAttachment(bytes, basename(path), mimeType);
}

/** Shared validation: read the file and reject anything the node would. */
function checkImage(path: string, mimeType: string, maxBytes: number): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new MediaError(
      `could not read "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return checkImageBytes(bytes, basename(path), mimeType, maxBytes);
}

/**
 * Shared validation over raw bytes, regardless of where they came from (a
 * local file or a downloaded URL) — reject anything the node would, AND
 * anything whose actual content doesn't match its claimed type.
 */
function checkImageBytes(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  maxBytes: number,
): Uint8Array {
  if (bytes.byteLength === 0) throw new MediaError(`"${filename}" is empty`);
  if (bytes.byteLength > maxBytes) {
    throw new MediaError(
      `"${filename}" is ${Math.round(bytes.byteLength / 1024)} KB, over the ` +
        `${Math.round(maxBytes / 1024)} KB limit`,
    );
  }
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new MediaError(
      `"${filename}" has unsupported MIME type "${mimeType}" ` +
        `(only jpeg/png/gif/webp are accepted)`,
    );
  }
  if (!matchesMagicBytes(bytes, mimeType)) {
    // The claimed type (a file extension for imagedir, a remote
    // Content-Type header for a feed image) disagrees with the bytes
    // themselves — never trust the claim alone.
    throw new MediaError(`"${filename}" does not look like a real ${mimeType} file`);
  }
  return bytes;
}

/** Build the (not-yet-uploaded) attachment descriptor shared by both validate-only entry points. */
function placeholderAttachment(bytes: Uint8Array, filename: string, mimeType: string): Attachment {
  return {
    cid: 'dry-run-not-uploaded',
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    filename,
  };
}

/**
 * Upload an image and return the attachment descriptor for the post.
 *
 * @param client    Authenticated SDK client.
 * @param path      Absolute path to the image.
 * @param mimeType  Its MIME type, from the file extension.
 * @param maxBytes  Refuse anything larger.
 */
export async function uploadImage(
  client: OgmaraClient,
  path: string,
  mimeType: string,
  maxBytes: number,
): Promise<Attachment> {
  const bytes = checkImage(path, mimeType, maxBytes);
  return performUpload(client, bytes, basename(path), mimeType);
}

/**
 * Run every check {@link uploadImageBytes} does, but skip the network write.
 *
 * Same purpose as {@link validateImageOnly}, for bytes that didn't come from
 * a local file (a downloaded feed image).
 */
export function validateImageBytesOnly(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  maxBytes: number,
): Attachment {
  checkImageBytes(bytes, filename, mimeType, maxBytes);
  return placeholderAttachment(bytes, filename, mimeType);
}

/**
 * Upload already-in-memory image bytes (e.g. downloaded from a feed's
 * enclosure/thumbnail URL) and return the attachment descriptor for the post.
 *
 * @param client    Authenticated SDK client.
 * @param bytes     Raw image bytes.
 * @param filename  Name to give the upload — cosmetic only, not a path.
 * @param mimeType  Claimed MIME type (e.g. from the source's Content-Type
 *                  header) — verified against the bytes' real signature
 *                  before anything is uploaded, never trusted alone.
 * @param maxBytes  Refuse anything larger.
 */
export async function uploadImageBytes(
  client: OgmaraClient,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  maxBytes: number,
): Promise<Attachment> {
  checkImageBytes(bytes, filename, mimeType, maxBytes);
  return performUpload(client, bytes, filename, mimeType);
}

/** The actual network upload, assuming `bytes` has already passed {@link checkImageBytes}. */
async function performUpload(
  client: OgmaraClient,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<Attachment> {
  // Copy into a fresh ArrayBuffer: a Node Buffer (what checkImage may have
  // received from readFileSync) is a view onto a shared pool, so passing it
  // straight to Blob can capture neighbouring bytes.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const blob = new Blob([view], { type: mimeType });

  let result;
  try {
    result = await client.uploadMedia(blob, filename);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The node answers 503 specifically when its IPFS backend is unreachable,
    // which is an operator/infrastructure problem, not a bad file — 'unavailable'.
    if (message.includes('503')) {
      throw new MediaError(
        'the node cannot accept media right now (IPFS backend offline). ' +
          'Check the node, or point the bot at a media-capable one.',
        'unavailable',
      );
    }
    // Any other upload failure here (timeout, connection reset, DNS) is also
    // a network/node problem, never something about the bytes themselves —
    // those were already validated above before this call was ever made.
    throw new MediaError(`upload of "${filename}" failed: ${message}`, 'unavailable');
  }

  return {
    cid: result.cid,
    mime_type: mimeType,
    size_bytes: result.size,
    filename,
    ...(result.thumbnail_cid !== undefined ? { thumbnail_cid: result.thumbnail_cid } : {}),
  };
}
