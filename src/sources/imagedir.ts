/**
 * Image-directory source — posts a picture from a local folder, captioned by a
 * vision model.
 *
 * Two decisions worth stating:
 *
 * - **Files are identified by content hash, not by path.** Renaming, moving
 *   between watched directories, or keeping the same picture under two names
 *   would otherwise republish it. Hashing is cheap next to the AI call and the
 *   upload that follow.
 * - **Selection is random, not alphabetical.** A folder posted in filename
 *   order reads like a directory listing. The ledger prevents repeats, so
 *   randomness costs nothing.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Candidate, PollResult, Source } from './types.js';

/** Extensions considered images, mapped to the MIME type the node expects. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Options for {@link ImageDirSource}. */
export interface ImageDirSourceOptions {
  /** Directories to scan. Not recursive — see the note in `scanDirectory`. */
  directories: readonly string[];
  /** Skip files larger than this. Must stay under the node's upload cap. */
  maxBytes: number;
  /** Injected for tests. */
  random?: () => number;
}

/** MIME type for a path, or undefined when it is not a supported image. */
export function imageMimeType(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()];
}

/** One image found on disk. */
export interface FoundImage {
  path: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * List supported images directly inside a directory.
 *
 * Deliberately **not** recursive. An operator points this at a pictures folder;
 * silently walking into subdirectories could pull in an entire home directory
 * and publish something they never intended. Recursion can be added as an
 * explicit opt-in if anyone asks.
 */
export function scanDirectory(dir: string, maxBytes: number): {
  images: FoundImage[];
  warnings: string[];
} {
  const images: FoundImage[] = [];
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { images: [], warnings: [`image directory "${dir}" is unreadable: ${reason}`] };
  }

  for (const entry of entries) {
    const mimeType = imageMimeType(entry);
    if (mimeType === undefined) continue;

    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      if (stat.size > maxBytes) {
        warnings.push(
          `skipping "${entry}": ${Math.round(stat.size / 1024)} KB exceeds the ${Math.round(maxBytes / 1024)} KB limit`,
        );
        continue;
      }
      if (stat.size === 0) continue;
      images.push({ path: full, mimeType, sizeBytes: stat.size });
    } catch {
      // Vanished between readdir and stat, or unreadable — skip quietly.
    }
  }

  return { images, warnings };
}

/** SHA-256 of a file's bytes, hex-encoded. */
export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export class ImageDirSource implements Source {
  readonly kind = 'imagedir' as const;
  readonly name = 'imagedir';

  readonly #directories: readonly string[];
  readonly #maxBytes: number;
  readonly #random: () => number;

  constructor(options: ImageDirSourceOptions) {
    this.#directories = options.directories;
    this.#maxBytes = options.maxBytes;
    this.#random = options.random ?? Math.random;
  }

  async poll(): Promise<PollResult> {
    const warnings: string[] = [];
    const found: FoundImage[] = [];

    for (const dir of this.#directories) {
      const result = scanDirectory(dir, this.#maxBytes);
      found.push(...result.images);
      warnings.push(...result.warnings);
    }

    if (found.length === 0) {
      warnings.push(
        `no usable images found in: ${this.#directories.join(', ')} ` +
          `(supported: ${Object.keys(IMAGE_MIME).join(', ')})`,
      );
      return { candidates: [], warnings };
    }

    // Shuffle so selection is not filename-ordered. The pipeline takes the
    // first unseen candidate, so shuffling here is what makes it random.
    const shuffled = [...found];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    const candidates: Candidate[] = [];
    for (const image of shuffled) {
      try {
        candidates.push({
          // Content hash, so a rename or a copy in another watched folder is
          // recognised as the same picture.
          dedupKey: `img:${hashFile(image.path)}`,
          kind: 'imagedir',
          title: image.path,
          imagePath: image.path,
          imageMimeType: image.mimeType,
        });
      } catch (err) {
        warnings.push(
          `could not read "${image.path}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { candidates, warnings };
  }
}
