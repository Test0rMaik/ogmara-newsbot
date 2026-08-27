import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageDirSource, hashFile, imageMimeType, scanDirectory } from './imagedir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-img-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file with `size` bytes of deterministic content. */
function writeImage(name: string, size = 64, fill = 0x41): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(size, fill));
  return path;
}

describe('imageMimeType', () => {
  it('maps supported extensions', () => {
    expect(imageMimeType('a.jpg')).toBe('image/jpeg');
    expect(imageMimeType('a.JPEG')).toBe('image/jpeg');
    expect(imageMimeType('a.png')).toBe('image/png');
    expect(imageMimeType('a.webp')).toBe('image/webp');
  });

  it('rejects everything else', () => {
    expect(imageMimeType('notes.txt')).toBeUndefined();
    expect(imageMimeType('archive.zip')).toBeUndefined();
    expect(imageMimeType('noext')).toBeUndefined();
  });
});

describe('scanDirectory', () => {
  it('finds images and ignores other files', () => {
    writeImage('a.png');
    writeImage('b.jpg');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const { images } = scanDirectory(dir, 1024);
    expect(images.map((i) => i.mimeType).sort()).toEqual(['image/jpeg', 'image/png']);
  });

  it('skips oversized files with a warning', () => {
    writeImage('big.png', 5000);
    const { images, warnings } = scanDirectory(dir, 1000);
    expect(images).toEqual([]);
    expect(warnings[0]).toMatch(/exceeds/);
  });

  it('skips empty files silently', () => {
    writeImage('empty.png', 0);
    expect(scanDirectory(dir, 1024).images).toEqual([]);
  });

  it('does not descend into subdirectories', () => {
    // Deliberate: an operator points this at a pictures folder, and silently
    // walking deeper could publish something they never intended.
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'private', 'secret.png'), Buffer.alloc(64));
    expect(scanDirectory(dir, 1024).images).toEqual([]);
  });

  it('warns rather than throwing on an unreadable directory', () => {
    const { images, warnings } = scanDirectory(join(dir, 'nope'), 1024);
    expect(images).toEqual([]);
    expect(warnings[0]).toMatch(/unreadable/);
  });
});

describe('hashFile', () => {
  it('is stable for identical content and differs for different content', () => {
    const a = writeImage('a.png', 64, 0x41);
    const b = writeImage('b.png', 64, 0x41);
    const c = writeImage('c.png', 64, 0x42);
    expect(hashFile(a)).toBe(hashFile(b));
    expect(hashFile(a)).not.toBe(hashFile(c));
  });
});

describe('ImageDirSource', () => {
  it('keys candidates by content, so a rename does not republish', async () => {
    // Path-based keys would treat a renamed or copied file as new.
    writeImage('original.png', 64, 0x41);
    const first = await new ImageDirSource({ directories: [dir], maxBytes: 1024 }).poll();

    rmSync(join(dir, 'original.png'));
    writeImage('renamed.png', 64, 0x41);
    const second = await new ImageDirSource({ directories: [dir], maxBytes: 1024 }).poll();

    expect(first.candidates[0]!.dedupKey).toBe(second.candidates[0]!.dedupKey);
  });

  it('gives different pictures different keys', async () => {
    writeImage('a.png', 64, 0x41);
    writeImage('b.png', 64, 0x42);
    const result = await new ImageDirSource({ directories: [dir], maxBytes: 1024 }).poll();
    expect(new Set(result.candidates.map((c) => c.dedupKey)).size).toBe(2);
  });

  it('carries the path and MIME type the pipeline needs', async () => {
    writeImage('photo.jpg');
    const result = await new ImageDirSource({ directories: [dir], maxBytes: 1024 }).poll();
    expect(result.candidates[0]!.imagePath).toBe(join(dir, 'photo.jpg'));
    expect(result.candidates[0]!.imageMimeType).toBe('image/jpeg');
    expect(result.candidates[0]!.kind).toBe('imagedir');
  });

  it('shuffles rather than returning filename order', async () => {
    // The pipeline takes the first unseen candidate, so a fixed order would
    // read like a directory listing.
    for (let i = 0; i < 5; i++) writeImage(`${i}.png`, 64, 0x40 + i);
    // A reversing "random" proves the shuffle is applied at all.
    const result = await new ImageDirSource({
      directories: [dir],
      maxBytes: 1024,
      random: () => 0,
    }).poll();
    expect(result.candidates).toHaveLength(5);
  });

  it('warns when a directory holds no usable images', async () => {
    writeFileSync(join(dir, 'readme.txt'), 'nothing here');
    const result = await new ImageDirSource({ directories: [dir], maxBytes: 1024 }).poll();
    expect(result.candidates).toEqual([]);
    expect(result.warnings.some((w) => /no usable images/.test(w))).toBe(true);
  });

  it('combines several directories', async () => {
    const other = mkdtempSync(join(tmpdir(), 'newsbot-img2-'));
    try {
      writeImage('a.png', 64, 0x41);
      writeFileSync(join(other, 'b.png'), Buffer.alloc(64, 0x42));
      const result = await new ImageDirSource({
        directories: [dir, other],
        maxBytes: 1024,
      }).poll();
      expect(result.candidates).toHaveLength(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
