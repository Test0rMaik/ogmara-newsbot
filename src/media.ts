/**
 * Media upload — putting an image on IPFS through the node so a post can
 * reference it.
 *
 * The node pins the bytes and returns a CID, which goes into the post's
 * `attachments`. Two node-side facts drive the checks here, because failing
 * before the upload is much cheaper than failing during one:
 *
 * - Media capability is a **live** signal, not a static config flag. A node can
 *   be configured for IPFS with the daemon down, so `/api/v1/health` reports
 *   `media_uploads` per-request and the bot must consult it rather than assume.
 * - The node enforces a MIME allowlist (`image/`, `video/`, `audio/`,
 *   `application/pdf`, `text/plain`) and a size cap (50 MB by default).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Attachment, OgmaraClient } from '@ogmara/sdk';

/** Raised when an image cannot be uploaded for a reason the operator must fix. */
export class MediaError extends Error {
  override readonly name = 'MediaError';
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
  return {
    cid: 'dry-run-not-uploaded',
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    filename: basename(path),
  };
}

/** Shared validation: read the file and reject anything the node would. */
function checkImage(path: string, mimeType: string, maxBytes: number): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new MediaError(
      `could not read "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (bytes.byteLength === 0) throw new MediaError(`"${path}" is empty`);
  if (bytes.byteLength > maxBytes) {
    throw new MediaError(
      `"${basename(path)}" is ${Math.round(bytes.byteLength / 1024)} KB, over the ` +
        `${Math.round(maxBytes / 1024)} KB limit`,
    );
  }
  if (!mimeType.startsWith('image/')) {
    // The node's allowlist is broader, but this bot only ever posts images —
    // anything else here means the extension map and the caller disagree.
    throw new MediaError(`"${basename(path)}" has non-image MIME type "${mimeType}"`);
  }
  return bytes;
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
  const filename = basename(path);
  // Copy into a fresh ArrayBuffer: a Node Buffer is a view onto a shared
  // pool, so passing it straight to Blob can capture neighbouring bytes.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const blob = new Blob([view], { type: mimeType });

  let result;
  try {
    result = await client.uploadMedia(blob, filename);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The node answers 503 specifically when its IPFS backend is unreachable,
    // which is an operator problem rather than a bad file.
    if (message.includes('503')) {
      throw new MediaError(
        'the node cannot accept media right now (IPFS backend offline). ' +
          'Check the node, or point the bot at a media-capable one.',
      );
    }
    throw new MediaError(`upload of "${filename}" failed: ${message}`);
  }

  return {
    cid: result.cid,
    mime_type: mimeType,
    size_bytes: result.size,
    filename,
    ...(result.thumbnail_cid !== undefined ? { thumbnail_cid: result.thumbnail_cid } : {}),
  };
}
