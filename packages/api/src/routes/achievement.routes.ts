import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/http.js';
import { getAchievements, getAchievementsProgress, collectMetrics } from '../services/achievement.service.js';

/**
 * Achievement routes (Section 4 — `/achievements/*`, Section 6 Screen 13).
 *
 * Badges are evaluated lazily: every request recomputes the metrics from the
 * user's own rows and awards anything newly unlocked. There is no event bus to
 * keep in sync, and a badge can never be missed because a write path forgot to
 * emit something.
 */
export async function achievementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/', {
    schema: {
      tags: ['achievements'],
      summary: 'All badges with per-badge progress',
      description:
        'Each badge reports `current` against `target` so the UI can render a progress ring even ' +
        'for badges that are still locked.',
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => ok(reply, await getAchievements(request.user!.id)));

  app.get('/progress', {
    schema: {
      tags: ['achievements'],
      summary: 'Points, level, streak and the full badge list',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getAchievementsProgress(request.user!.id)));

  app.get('/metrics', {
    schema: {
      tags: ['achievements'],
      summary: 'Raw achievement metrics (debug / "why is this badge at 60%?")',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await collectMetrics(request.user!.id)));
}
