import { describe, expect, it } from 'vitest';
import { preprocessImage, sniffMimeType, validateImageInput } from '../../src/lib/image.js';
import { UPLOAD_LIMITS } from '@platematch/shared';
import { AppError } from '../../src/lib/errors.js';

/**
 * Upload admission and the image pipeline.
 *
 * The interesting case is the one that used to pass: a body of arbitrary bytes
 * with `content-type: image/jpeg`. The allow-list fell back to the *declared*
 * type whenever magic-byte sniffing found nothing, so forged uploads were
 * admitted, forwarded to a vision provider and written to storage. Sniffing is
 * now a requirement rather than a cross-check.
 */

/** Just enough header for `sniffMimeType` to recognise the format. */
function header(bytes: number[], padTo = 32): Buffer {
  const buffer = Buffer.alloc(padTo, 0x20);
  Buffer.from(bytes).copy(buffer);
  return buffer;
}

const JPEG = header([0xff, 0xd8, 0xff, 0xe0]);
const PNG = header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = (() => {
  const buffer = Buffer.alloc(32, 0x20);
  buffer.write('RIFF', 0, 'latin1');
  buffer.write('WEBP', 8, 'latin1');
  return buffer;
})();
const GIF = header([...Buffer.from('GIF89a', 'latin1')]);
const HEIC = (() => {
  const buffer = Buffer.alloc(32, 0x20);
  buffer.write('ftypheic', 4, 'latin1');
  return buffer;
})();

/**
 * A 64x64 image with real structure — a horizontal or vertical ramp.
 *
 * Solid colours are degenerate for an average hash (see the test below), so
 * fixtures that need a meaningful hash have to contain variance.
 */
async function pattern(orientation: 0 | 1): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const size = 64;
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = orientation === 0 ? (x * 4) % 256 : (y * 4) % 256;
      const at = (y * size + x) * 3;
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).jpeg().toBuffer();
}

/** Status code of an AppError, so the assertions do not depend on class identity. */
function statusOf(error: unknown): number | undefined {
  return error instanceof AppError ? error.statusCode : (error as { statusCode?: number })?.statusCode;
}

describe('sniffMimeType', () => {
  it('recognises every format the product accepts from magic bytes', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(WEBP)).toBe('image/webp');
  });

  it('recognises formats it will nonetheless refuse', () => {
    expect(sniffMimeType(GIF)).toBe('image/gif');
    expect(sniffMimeType(HEIC)).toBe('image/heic');
  });

  it('returns null for bytes that are not an image, however they are labelled', () => {
    expect(sniffMimeType(Buffer.from('this is not an image', 'utf8'))).toBeNull();
    expect(sniffMimeType(Buffer.from('<html><body>hi</body></html>', 'utf8'))).toBeNull();
  });

  it('returns null rather than guessing for a truncated header', () => {
    expect(sniffMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('validateImageInput', () => {
  it('accepts each allowed format', () => {
    for (const [buffer, mime] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']] as const) {
      expect(() => validateImageInput(buffer, mime)).not.toThrow();
    }
  });

  it('accepts an allowed image whose declared type is missing', () => {
    expect(() => validateImageInput(JPEG, undefined)).not.toThrow();
  });

  // --- the regression -------------------------------------------------------

  it('refuses non-image bytes even when they claim to be image/jpeg', () => {
    const forged = Buffer.from('rm -rf / -- definitely not a jpeg', 'utf8');

    expect(() => validateImageInput(forged, 'image/jpeg')).toThrowError(/not a recognisable image/);
    try {
      validateImageInput(forged, 'image/jpeg');
    } catch (error) {
      expect(statusOf(error)).toBe(415);
    }
  });

  it('refuses a disallowed format that claims to be an allowed one', () => {
    // HEIC magic bytes, image/jpeg header: the declared type used to win.
    expect(() => validateImageInput(HEIC, 'image/jpeg')).toThrowError(/Unsupported image type "image\/heic"/);
    expect(() => validateImageInput(GIF, 'image/png')).toThrowError(/Unsupported image type "image\/gif"/);
  });

  it('names the declared type in the refusal, so a client can see what it sent', () => {
    expect(() => validateImageInput(Buffer.from('plain text', 'utf8'), 'text/plain')).toThrowError(/text\/plain/);
  });

  // --- the other guards -----------------------------------------------------

  it('refuses an empty body with 400', () => {
    try {
      validateImageInput(Buffer.alloc(0), 'image/jpeg');
      expect.unreachable('empty buffer should throw');
    } catch (error) {
      expect(statusOf(error)).toBe(400);
    }
  });

  it('refuses an oversized body with 413', () => {
    try {
      validateImageInput(JPEG, 'image/jpeg', { maxBytes: 8 });
      expect.unreachable('oversized buffer should throw');
    } catch (error) {
      expect(statusOf(error)).toBe(413);
    }
  });

  it('honours a caller-narrowed allow-list', () => {
    expect(() => validateImageInput(PNG, 'image/png', { allowedMimeTypes: ['image/jpeg'] })).toThrowError(/Unsupported/);
    expect(() => validateImageInput(JPEG, 'image/jpeg', { allowedMimeTypes: ['image/jpeg'] })).not.toThrow();
  });

  it('ignores a charset parameter on the declared type', () => {
    expect(() => validateImageInput(JPEG, 'image/jpeg; charset=binary')).not.toThrow();
  });

  it('agrees with the shared upload limits', () => {
    expect(UPLOAD_LIMITS.allowedMimeTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    for (const mime of UPLOAD_LIMITS.allowedMimeTypes) {
      const buffer = mime === 'image/jpeg' ? JPEG : mime === 'image/png' ? PNG : WEBP;
      expect(() => validateImageInput(buffer, mime)).not.toThrow();
    }
  });
});

describe('preprocessImage', () => {
  it('downscales and re-encodes to JPEG, reporting both dimension pairs', async () => {
    // A real image, not a synthetic header: this exercises libvips itself, so a
    // sharp upgrade that changes behaviour fails here rather than in production.
    const sharp = (await import('sharp')).default;
    const source = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 45, g: 143, b: 78 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await preprocessImage(source, { maxSide: 1024 });

    expect(result.processed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.originalWidth).toBe(3000);
    expect(result.originalHeight).toBe(2000);
    expect(result.width).toBeLessThanOrEqual(1024);
    expect(result.height).toBeLessThanOrEqual(1024);
    expect(result.bytes).toBe(result.buffer.byteLength);
    expect(result.bytes).toBeLessThan(source.byteLength);
    // Aspect ratio survives the downscale.
    expect(Math.round((result.width / result.height) * 10)).toBe(15);
  });

  it('produces a stable hash for identical bytes and a different one for different images', async () => {
    const [a, b] = await Promise.all([preprocessImage(await pattern(0)), preprocessImage(await pattern(1))]);
    const again = await preprocessImage(await pattern(0));

    expect(a.hash).toMatch(/^[0-9a-f]+$/);
    expect(a.hash).toBe(again.hash);
    expect(a.hash).not.toBe(b.hash);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('reports no usable hash for a solid-colour frame, so dedupe cannot collide', async () => {
    // An average hash compares each pixel to the mean, so a frame with no
    // variance hashes to all zeros whatever its colour. Two different solid
    // colours would otherwise share a dedupe key and the second scan would be
    // handed the first one's results.
    const sharp = (await import('sharp')).default;
    const solid = (r: number, g: number, b: number) =>
      sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

    const green = await preprocessImage(await solid(45, 143, 78));
    const red = await preprocessImage(await solid(200, 30, 30));

    expect(green.hash).toBe('');
    expect(red.hash).toBe('');
    expect(green.hash).toBe(red.hash);
    // Still distinguishable by content, so nothing else is lost.
    expect(green.contentHash).not.toBe(red.contentHash);
    expect(green.processed).toBe(true);
  });

  it('does not enlarge an image smaller than the cap', async () => {
    const sharp = (await import('sharp')).default;
    const small = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ffffff' } })
      .jpeg()
      .toBuffer();

    const result = await preprocessImage(small, { maxSide: 1024 });

    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
  });
});
