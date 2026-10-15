import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/**
 * Raw request bodies.
 *
 * Stripe signs the exact bytes it sent, so signature verification fails if the
 * body has been through `JSON.parse` and `JSON.stringify` on the way. This
 * plugin captures the payload as a Buffer on `request.rawBody` while still
 * handing Fastify the parsed object for normal handlers.
 *
 * Registered globally but cheap: the parser only buffers what Fastify was going
 * to parse anyway.
 */
async function rawBodyPlugin(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as { rawBody?: Buffer }).rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body as string);

    // An empty body is legal for some webhook deliveries.
    if (!body || (Buffer.isBuffer(body) && body.length === 0)) {
      done(null, undefined);
      return;
    }

    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
}

export default fp(rawBodyPlugin, { name: 'raw-body', fastify: '5.x' });

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}
