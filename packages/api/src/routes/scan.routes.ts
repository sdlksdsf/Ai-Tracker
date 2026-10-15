import type { FastifyInstance } from 'fastify';
import type { ConfirmScanInput, ScanHistoryQuery } from '@platematch/shared';
import { confirmScanSchema, scanHistoryQuerySchema, scanRequestSchema } from '@platematch/shared';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { ok, pageParams } from '../lib/http.js';
import { rateLimits } from '../lib/ratelimit.js';
import { track } from '../plugins/telemetry.js';
import {
  confirmScan,
  createScan,
  getScanDetail,
  getScanStatus,
  listScanHistory,
  scanConfidenceSummary,
} from '../services/scan.service.js';

/**
 * Fridge-scan routes (Section 4 — `/scan/*`).
 *
 * The scan is the most expensive endpoint in the app (image upload + a vision
 * model), so it carries the strictest rate limit: 5 requests/minute/user.
 *
 * Two delivery modes:
 *   • default  — returns `{ scan_id, status: "queued" }` immediately; the client
 *                polls `GET /scan/status/:id` (or listens for the push).
 *   • `wait=true` — blocks until the pipeline finishes and returns the result
 *                   inline. Used by the mobile app on a good connection so the
 *                   result screen can render without a polling round-trip.
 */
export async function scanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // POST /scan/fridge
  // -------------------------------------------------------------------------
  app.post('/fridge', {
    config: { rateLimit: rateLimits.scan() },
    schema: {
      tags: ['scan'],
      summary: 'Upload a fridge photo and detect the ingredients',
      description:
        'Accepts `multipart/form-data` with an `image` field (JPEG/PNG/WebP, ≤10 MB). ' +
        'Query params control the mode: `source=camera|gallery`, `wait=true|false`, `skip_boxes=true|false`.',
      consumes: ['multipart/form-data'],
      querystring: jsonSchemaFrom(scanRequestSchema),
      response: {
        202: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                scan_id: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] },
                estimated_time_s: { type: 'integer' },
                photo_url: { type: ['string', 'null'] },
                result: { type: ['object', 'null'], additionalProperties: true },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = scanRequestSchema.parse(request.query ?? {});
    const upload = await request.readImageUpload('image');

    const result = await createScan({
      userId: request.user!.id,
      imageBuffer: upload.buffer,
      mimeType: upload.mimeType,
      filename: upload.filename,
      source: query.source,
      wait: query.wait,
      skipBoxes: query.skip_boxes,
    });

    track('scan_started', request.user!.id, {
      source: query.source,
      waited: query.wait,
      bytes: upload.buffer.byteLength,
    });

    if (result.result) {
      const confidence = scanConfidenceSummary(result.result.detected_items ?? []);
      track('scan_completed', request.user!.id, {
        items: confidence.accepted,
        rejected: confidence.rejected,
        average_confidence: confidence.averageConfidence,
      });
    }

    return ok(reply, result, 202);
  });

  // -------------------------------------------------------------------------
  // GET /scan/status/:scanId  — polled by the client
  // -------------------------------------------------------------------------
  app.get('/status/:scanId', {
    schema: {
      tags: ['scan'],
      summary: 'Poll a scan until it reaches `completed` or `failed`',
      params: {
        type: 'object',
        properties: { scanId: { type: 'string', format: 'uuid' } },
        required: ['scanId'],
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    return ok(reply, await getScanStatus(request.user!.id, scanId));
  });

  // -------------------------------------------------------------------------
  // GET /scan/:scanId — full record including confirmation counts
  // -------------------------------------------------------------------------
  app.get('/:scanId', {
    schema: {
      tags: ['scan'],
      summary: 'Full scan record (detections + confirmation stats)',
      params: {
        type: 'object',
        properties: { scanId: { type: 'string', format: 'uuid' } },
        required: ['scanId'],
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    return ok(reply, await getScanDetail(request.user!.id, scanId));
  });

  // -------------------------------------------------------------------------
  // GET /scan — history
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['scan'],
      summary: 'Scan history, newest first',
      querystring: jsonSchemaFrom(scanHistoryQuerySchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            meta: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = scanHistoryQuerySchema.parse(request.query ?? {}) as ScanHistoryQuery;
    const params = pageParams(query, { limit: 10, maxLimit: 50 });
    const result = await listScanHistory(request.user!.id, params.page, params.limit);
    return reply.send({ data: result.items, meta: { page: params.page, limit: params.limit, total: result.total, has_more: params.page * params.limit < result.total, next_cursor: null } });
  });

  // -------------------------------------------------------------------------
  // POST /scan/:scanId/confirm — write the reviewed detections into the pantry
  // -------------------------------------------------------------------------
  app.post('/:scanId/confirm', {
    schema: {
      tags: ['scan'],
      summary: 'Confirm a scan — accepted items become pantry items',
      description:
        'The user reviews the AI detections before anything is stored. `removed` items are never ' +
        'persisted, `corrected` names are recorded so we can measure model accuracy over time, and ' +
        '`added` covers what the model missed.',
      params: {
        type: 'object',
        properties: { scanId: { type: 'string', format: 'uuid' } },
        required: ['scanId'],
      },
      body: jsonSchemaFrom(confirmScanSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    const input = confirmScanSchema.parse(request.body) as ConfirmScanInput;

    const result = await confirmScan(request.user!.id, scanId, input);

    track('scan_confirmed', request.user!.id, {
      confirmed: input.confirmed.length,
      removed: input.removed.length,
      added: input.added.length,
      corrected: input.corrected.length,
    });

    return ok(reply, result);
  });
}
