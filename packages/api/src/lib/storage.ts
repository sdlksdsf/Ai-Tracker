import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { UpstreamServiceError } from './errors.js';
import { sha256, shortId } from './crypto.js';

/**
 * File storage abstraction (Section 2 — Infrastructure).
 *
 * Three interchangeable drivers:
 *   • `cloudinary` — production default. Unsigned-free signed upload via the
 *     REST API, with automatic WebP/AVIF delivery and responsive derivatives.
 *   • `s3`         — S3-compatible object storage (AWS S3, Supabase Storage,
 *     Cloudflare R2, MinIO for local dev). Uses presigned-style PUT with
 *     basic auth via the AWS Signature V4 helper below.
 *   • `local`      — writes to `./uploads` and serves them from `/uploads/*`.
 *     Perfect for a zero-config first run.
 *
 * The driver is selected by `STORAGE_DRIVER`; all of them return the same
 * `UploadResult` so callers never branch on it.
 */

export interface UploadInput {
  buffer: Buffer;
  mimeType: string;
  /** Logical folder, e.g. `scans/{userId}/{yyyy-mm-dd}`. */
  folder: string;
  /** Original file name (used for extension detection only). */
  filename?: string;
  /** Pre-computed id to use as the object key (defaults to a random one). */
  key?: string;
}

export interface UploadResult {
  /** Publicly readable URL. */
  url: string;
  /** Storage-relative key. */
  key: string;
  driver: 'cloudinary' | 's3' | 'local';
  bytes: number;
  /** Cloudinary-only: responsive derivative URLs. */
  variants?: Record<string, string>;
  /** Cloudinary-only: tiny base64 placeholder for blur-up loading. */
  blurDataUrl?: string;
}

/** The driver this deployment will use — surfaced by `/health`. */
export function storageDriverName(): UploadResult['driver'] {
  const configured = (env.STORAGE_DRIVER ?? 'local') as UploadResult['driver'];
  if (configured === 'cloudinary') {
    return env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET ? 'cloudinary' : 'local';
  }
  if (configured === 's3') {
    return env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? 's3' : 'local';
  }
  return 'local';
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
};

function extFor(mimeType: string, filename?: string): string {
  if (EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType] as string;
  const fromName = filename ? path.extname(filename).replace('.', '').toLowerCase() : '';
  return fromName || 'bin';
}

function sanitizeFolder(folder: string): string {
  return folder
    .split('/')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .filter(Boolean)
    .join('/');
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------

let localDirReady: Promise<string> | null = null;

function ensureLocalDir(): Promise<string> {
  if (!localDirReady) {
    localDirReady = (async () => {
      const dir = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR);
      await mkdir(dir, { recursive: true });
      return dir;
    })();
  }
  return localDirReady;
}

async function uploadLocal(input: UploadInput): Promise<UploadResult> {
  const root = await ensureLocalDir();
  const key = `${sanitizeFolder(input.folder)}/${input.key ?? shortId(12)}.${extFor(input.mimeType, input.filename)}`;
  const absolute = path.join(root, key);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFileBuffer(absolute, input.buffer);

  const url = `${env.APP_URL.replace(/\/$/, '')}/uploads/${key}`;
  return { url, key, driver: 'local', bytes: input.buffer.byteLength };
}

async function writeFileBuffer(absolute: string, buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(absolute);
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(buffer);
  });
}

/** Absolute path for a locally stored key (used by the /uploads static route). */
export function localPathForKey(key: string): string {
  return path.join(path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR), key);
}

export async function deleteLocal(key: string): Promise<void> {
  try {
    await unlink(localPathForKey(key));
  } catch {
    /* already gone — nothing to do */
  }
}

// ---------------------------------------------------------------------------
// Cloudinary driver
// ---------------------------------------------------------------------------

async function uploadCloudinary(input: UploadInput): Promise<UploadResult> {
  const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: key, CLOUDINARY_API_SECRET: secret } = env;
  if (!cloud || !key || !secret) {
    throw new UpstreamServiceError('Cloudinary is not configured (set CLOUDINARY_* env vars)');
  }

  const folder = `${sanitizeFolder(env.CLOUDINARY_FOLDER)}/${sanitizeFolder(input.folder)}`;
  const publicId = input.key ?? `${shortId(10)}-${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);

  // Signed upload: sha1(params + api_secret)
  //
  // No incoming `transformation`. This used to send `f_auto,q_auto`, which
  // Cloudinary documents as "never use f_auto in an incoming transformation"
  // (format must be chosen per browser at delivery time). The bytes arriving
  // here are already downscaled and re-encoded as JPEG q85 by lib/image.ts, so
  // an incoming q_auto would only compress them a second time. Apply
  // f_auto/q_auto in delivery URLs instead.
  const params: Record<string, string | number> = {
    timestamp,
    folder,
    public_id: publicId,
    overwrite: 'false',
    // Responsive derivatives, generated in the background.
    eager: 'w_150,c_fill|w_300,c_fill|w_600,c_fill|w_1200,c_fill',
    eager_async: 'true',
  };
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = sha1Hex(`${paramString}${secret}`);

  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('signature', signature);
  form.append('api_key', key);
  form.append('file', `data:${input.mimeType};base64,${input.buffer.toString('base64')}`);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    const hint =
      res.status === 401 || res.status === 403
        ? 'Cloudinary rejected the credentials — re-copy CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (reveal the secret first; not the masked ****)'
        : res.status === 404
          ? 'Unknown Cloudinary cloud name — check CLOUDINARY_CLOUD_NAME'
          : 'Cloudinary refused the upload';
    logger.error({ status: res.status, body, cloud }, `Cloudinary upload failed: ${hint}`);
    throw new UpstreamServiceError(`Cloudinary upload failed (${res.status})`);
  }

  const data = (await res.json()) as {
    secure_url: string;
    public_id: string;
    eager?: Array<{ secure_url?: string; url?: string; width?: number }>;
    placeholder?: boolean;
  };

  const variants: Record<string, string> = {};
  for (const e of data.eager ?? []) {
    const url = e.secure_url ?? e.url;
    if (url && e.width) variants[String(e.width)] = url;
  }

  return {
    url: data.secure_url,
    key: data.public_id,
    driver: 'cloudinary',
    bytes: input.buffer.byteLength,
    variants: Object.keys(variants).length ? variants : undefined,
  };
}

function sha1Hex(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// S3 driver (AWS Signature V4, no SDK dependency)
// ---------------------------------------------------------------------------

async function uploadS3(input: UploadInput): Promise<UploadResult> {
  const {
    S3_BUCKET: bucket,
    S3_REGION: region,
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretKey,
    S3_PUBLIC_URL: publicUrl,
  } = env;

  if (!bucket || !accessKeyId || !secretKey) {
    throw new UpstreamServiceError('S3 storage is not configured (set S3_* env vars)');
  }

  const key = `${sanitizeFolder(input.folder)}/${input.key ?? shortId(12)}.${extFor(input.mimeType, input.filename)}`;
  const host = endpoint ? new URL(endpoint).host : `${bucket}.s3.${region}.amazonaws.com`;
  const basePath = endpoint ? new URL(endpoint).pathname.replace(/\/$/, '') : '';
  const pathName = endpoint ? `${basePath}/${bucket}/${key}` : `/${key}`;
  const url = `https://${host}${pathName}`;

  const signed = await signS3Request({
    method: 'PUT',
    url,
    region,
    accessKeyId,
    secretKey,
    headers: {
      'content-type': input.mimeType,
      'content-length': String(input.buffer.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: input.buffer,
  });

  const res = await fetch(url, { method: 'PUT', headers: signed, body: input.buffer });
  if (!res.ok && res.status !== 200) {
    const body = await res.text();
    logger.error({ status: res.status, body, key }, 'S3 upload failed');
    throw new UpstreamServiceError(`S3 upload failed (${res.status})`);
  }

  const publicBase = publicUrl ?? (endpoint ? `${endpoint.replace(/\/$/, '')}/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`);

  return {
    url: `${publicBase.replace(/\/$/, '')}/${key}`,
    key,
    driver: 's3',
    bytes: input.buffer.byteLength,
  };
}

/** Minimal AWS Signature V4 signer (supports S3 and S3-compatible endpoints). */
async function signS3Request(opts: {
  method: string;
  url: string;
  region: string;
  accessKeyId: string;
  secretKey: string;
  headers: Record<string, string>;
  body: Buffer;
  service?: string;
}): Promise<Record<string, string>> {
  const { createHmac, createHash: createHashFn } = await import('node:crypto');
  const service = opts.service ?? 's3';
  const parsed = new URL(opts.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: parsed.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': createHashFn('sha256').update(opts.body).digest('hex'),
  };

  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]!.trim()}\n`).join('');
  const signedHeaders = signedHeaderKeys.join(';');

  const canonicalQuery = [...parsed.searchParams].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    opts.method,
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, createHashFn(canonicalRequest).digest('hex')].join('\n');

  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const kDate = hmac(`AWS4${opts.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Upload a buffer with the configured driver. */
export async function uploadFile(input: UploadInput): Promise<UploadResult> {
  const started = Date.now();
  try {
    const result =
      env.STORAGE_DRIVER === 'cloudinary'
        ? await uploadCloudinary(input)
        : env.STORAGE_DRIVER === 's3'
          ? await uploadS3(input)
          : await uploadLocal(input);

    logger.debug(
      { driver: result.driver, key: result.key, bytes: result.bytes, ms: Date.now() - started },
      'File uploaded',
    );
    return result;
  } catch (err) {
    logger.error({ err, folder: input.folder }, 'File upload failed');
    throw err;
  }
}

/** Convenience wrapper for scan photos. */
export function uploadScanPhoto(userId: string, buffer: Buffer, mimeType: string, key?: string): Promise<UploadResult> {
  const date = new Date().toISOString().slice(0, 10);
  return uploadFile({ buffer, mimeType, folder: `scans/${userId}/${date}`, key });
}

export function uploadAvatar(userId: string, buffer: Buffer, mimeType: string): Promise<UploadResult> {
  return uploadFile({ buffer, mimeType, folder: `avatars/${userId}`, key: `avatar-${Date.now()}` });
}

export function uploadWastePhoto(userId: string, buffer: Buffer, mimeType: string): Promise<UploadResult> {
  const date = new Date().toISOString().slice(0, 10);
  return uploadFile({ buffer, mimeType, folder: `waste/${userId}/${date}` });
}

export function uploadRecipePhoto(userId: string, buffer: Buffer, mimeType: string): Promise<UploadResult> {
  return uploadFile({ buffer, mimeType, folder: `recipes/${userId}` });
}

/** Best-effort delete (never throws). */
export async function deleteFile(key: string): Promise<void> {
  try {
    if (env.STORAGE_DRIVER === 'local') await deleteLocal(key);
    // Cloudinary/S3 deletes are intentionally omitted from the MVP path —
    // objects are lifecycle-expired by the provider instead.
  } catch (err) {
    logger.warn({ err, key }, 'deleteFile failed');
  }
}

/** Read a file from disk into a buffer (used by tests and the local driver). */
export async function readFileBytes(file: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file);
}

/** Write a stream to disk (multipart uploads). */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Size of a file on disk, or null. */
export async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.size;
  } catch {
    return null;
  }
}

export { pipeline };
