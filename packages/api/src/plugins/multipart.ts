import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UPLOAD_LIMITS } from '@platematch/shared';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from '../lib/errors.js';
import { validateImageInput } from '../lib/image.js';

/**
 * Multipart uploads (Section 8).
 *
 * The fridge scan is the only endpoint that accepts a body this way. We cap the
 * file at 10 MB, refuse anything that is not an image, and stream the file into
 * memory exactly once — the same buffer is then handed to `preprocessImage`
 * (resize + EXIF strip) and to storage.
 */
async function multipartPlugin(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_LIMITS.maxBytes,
      files: 1,
      fields: 12,
      parts: 16,
      // Header buffer, not the file itself.
      headerPairs: 200,
    },
    attachFieldsToBody: false,
    // `toBuffer()` below throws FileSizeLimitExceededError when the cap is hit.
    throwFileSizeLimit: true,
  });

  /**
   * Read a single image upload off the request.
   *
   * Rejects non-image content types by both the declared MIME type and the
   * magic bytes in the payload, so a renamed executable cannot slip through.
   */
  app.decorateRequest('readImageUpload', async function readImageUpload(
    this: FastifyRequest,
    fieldName = 'image',
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    let part: Awaited<ReturnType<FastifyRequest['file']>>;

    try {
      part = await this.file();
    } catch (err) {
      // @fastify/multipart throws its own FastifyError ("the request is not
      // multipart") when the content type is wrong. Left uncaught it surfaced as
      // a 500, which tells a client "our server broke" when the real problem is
      // that it sent JSON to an upload endpoint.
      const message = (err as Error)?.message ?? '';
      if (/not multipart/i.test(message)) {
        throw new UnsupportedMediaTypeError(
          'Uploads must be sent as multipart/form-data with an image field.',
        );
      }
      if (/filesize|limit/i.test(message)) {
        throw new PayloadTooLargeError(
          `Image is larger than the ${Math.round(UPLOAD_LIMITS.maxBytes / (1024 * 1024))} MB limit.`,
        );
      }
      throw new BadRequestError(`Could not read the upload: ${message || 'unknown error'}`);
    }

    if (!part) throw new BadRequestError('No image was uploaded. Attach it as multipart form-data.');

    if (part.fieldname !== fieldName && !part.mimetype.startsWith('image/')) {
      throw new BadRequestError(`Expected an image in the '${fieldName}' field.`);
    }

    const buffer = await part.toBuffer();

    if (part.file.truncated) {
      throw new PayloadTooLargeError(
        `Image is larger than the ${Math.round(UPLOAD_LIMITS.maxBytes / (1024 * 1024))} MB limit.`,
      );
    }
    if (!buffer.length) throw new BadRequestError('The uploaded image is empty.');

    const declared = part.mimetype || 'application/octet-stream';
    if (!declared.startsWith('image/')) {
      throw new UnsupportedMediaTypeError(`'${declared}' is not an image. Use JPEG, PNG or WebP.`);
    }

    // Throws UnsupportedMediaTypeError / PayloadTooLargeError with a useful message.
    validateImageInput(buffer, declared);

    return { buffer, mimeType: declared, filename: part.filename || 'upload.jpg' };
  });
}

export default fp(multipartPlugin, { name: 'multipart', fastify: '5.x' });

declare module 'fastify' {
  interface FastifyRequest {
    readImageUpload(fieldName?: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }>;
  }
}

