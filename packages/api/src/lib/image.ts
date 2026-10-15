import { UPLOAD_LIMITS } from '@platematch/shared';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from './errors.js';
import { averageHashFromGray, sha256 } from './crypto.js';
import { logger } from './logger.js';

/**
 * Image preprocessing (Section 5, Step 1).
 *
 *   validate → downscale to ≤1536px on the longest side → re-encode JPEG q85
 *              → strip EXIF (privacy) → derive a perceptual hash
 *
 * Sharp is loaded lazily so unit tests and environments without the native
 * binary can still import this module.
 */

type SharpModule = typeof import('sharp');

let sharpModule: SharpModule | null = null;
let sharpLoadAttempted = false;

async function getSharp(): Promise<SharpModule | null> {
  if (sharpLoadAttempted) return sharpModule;
  sharpLoadAttempted = true;
  try {
    const mod = (await import('sharp')) as unknown as SharpModule & { default?: SharpModule };
    sharpModule = mod.default ?? mod;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'sharp unavailable — images will be forwarded unprocessed');
    sharpModule = null;
  }
  return sharpModule;
}

export interface ProcessedImage {
  /** JPEG buffer ready for the AI call / storage. */
  buffer: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  /** 64-bit average hash (hex) used to dedupe identical uploads. */
  hash: string;
  /** Content hash of the compressed bytes. */
  contentHash: string;
  /** Resized with sharp? False when sharp is unavailable. */
  processed: boolean;
  /** Dimensions before downscaling (when sharp reported them). */
  originalWidth?: number;
  originalHeight?: number;
}

export interface ValidateOptions {
  maxBytes?: number;
  allowedMimeTypes?: string[];
}

/** Reject oversized or non-image payloads before we spend any CPU on them. */
export function validateImageInput(buffer: Buffer, mimeType: string | undefined, opts: ValidateOptions = {}): void {
  const maxBytes = opts.maxBytes ?? UPLOAD_LIMITS.maxBytes;
  const allowed = opts.allowedMimeTypes ?? [...UPLOAD_LIMITS.allowedMimeTypes];

  if (!buffer || buffer.byteLength === 0) throw new BadRequestError('Image file is empty');
  if (buffer.byteLength > maxBytes) {
    throw new PayloadTooLargeError(
      `Image is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB — the maximum is ${Math.round(maxBytes / 1024 / 1024)}MB`,
    );
  }

  const sniffed = sniffMimeType(buffer);
  const declared = mimeType?.split(';')[0]?.trim().toLowerCase();

  if (!declared && !sniffed) throw new UnsupportedMediaTypeError('Could not determine the image type');
  const effective = declared ?? sniffed ?? '';

  if (!allowed.includes(effective)) {
    throw new UnsupportedMediaTypeError(
      `Unsupported image type "${effective}". Allowed: ${allowed.join(', ')}`,
    );
  }
  if (sniffed && sniffed !== effective) {
    // Declared type disagrees with the magic bytes — trust the bytes.
    logger.warn({ declared: effective, sniffed }, 'Image MIME mismatch; using sniffed type');
  }
}

/** Detect JPEG/PNG/WebP/GIF from magic bytes. */
export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a')
    return 'image/gif';
  if (buffer.subarray(4, 12).toString('latin1') === 'ftypheic') return 'image/heic';
  return null;
}

/**
 * Downscale + re-encode. Falls back to the original buffer when sharp is not
 * installed, so the pipeline never hard-fails on a missing native dependency.
 */
export async function preprocessImage(
  buffer: Buffer,
  opts: { maxSide?: number; quality?: number } = {},
): Promise<ProcessedImage> {
  const maxSide = opts.maxSide ?? UPLOAD_LIMITS.maxLongestSidePx;
  const quality = opts.quality ?? UPLOAD_LIMITS.jpegQuality;
  const sharp = await getSharp();

  if (!sharp) {
    return {
      buffer,
      mimeType: 'image/jpeg',
      width: 0,
      height: 0,
      bytes: buffer.byteLength,
      hash: '',
      contentHash: sha256(buffer),
      processed: false,
    };
  }

  const image = sharp(buffer, { failOn: 'none' }).rotate(); // rotate() honours EXIF orientation
  const metadata = await image.metadata();

  const resized = sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    // Strip EXIF/GPS metadata before we upload or send it to a third party.
    .withMetadata({ orientation: undefined })
    .jpeg({ quality, mozjpeg: true, progressive: true })
    .toBuffer({ resolveWithObject: true });

  const { data, info } = await resized;

  // 8x8 grayscale thumbnail → perceptual hash for duplicate-scan detection.
  const { data: gray } = await sharp(data)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = averageHashFromGray(new Uint8Array(gray));

  return {
    buffer: data,
    mimeType: 'image/jpeg',
    width: info.width,
    height: info.height,
    bytes: data.byteLength,
    hash,
    contentHash: sha256(data),
    processed: true,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
  } as ProcessedImage & { originalWidth?: number; originalHeight?: number };
}

/** Base64 data URI for provider calls that want one. */
export function toDataUri(buffer: Buffer, mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/** Raw base64 (no prefix) for Gemini `inline_data`. */
export function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/** Approximate vision-token cost of an image (OpenAI "high detail" tiles). */
export function estimateImageTokens(width: number, height: number): number {
  if (!width || !height) return 765;
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const shortSide = Math.min(w, h);
  const scale2 = shortSide > 768 ? 768 / shortSide : 1;
  const tilesW = Math.ceil((w * scale2) / 512);
  const tilesH = Math.ceil((h * scale2) / 512);
  return 85 + 170 * tilesW * tilesH;
}
