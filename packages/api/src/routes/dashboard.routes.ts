import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { ok } from '../lib/http.js';
import {
  buildWeeklyReport,
  getDashboard,
  getExpiringSoonItems,
  getHomeSummary,
  getRecipeOfTheDay,
  getRecentRecipes,
  getSavingsStats,
  getTrends,
  type StatsPeriod,
} from '../services/dashboard.service.js';

/**
 * Dashboard / Home routes (Section 6 Screen 2, plus the aggregates the Profile
 * and Savings screens read).
 *
 * These endpoints are pure reads over data the other services already wrote.
 * They are cached for 60–90 seconds in Redis and every write path invalidates
 * the relevant key, so the Home screen is fast without ever being stale.
 */
const savingsPeriodSchema = z.object({ period: z.enum(['week', 'month', 'year']).default('month') });
const trendsQuerySchema = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // GET /dashboard/home
  // -------------------------------------------------------------------------
  app.get('/home', {
    schema: {
      tags: ['dashboard'],
      summary: 'Everything the Home screen renders, in one request',
      description:
        'Greeting, savings and impact summary, pantry snapshot, expiring-soon carousel, today\'s ' +
        'planned meals, three recipe suggestions (ranked by pantry use and expiry pressure), ' +
        'waste stats, achievement progress and the current streak.',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getHomeSummary(request.user!.id)));

  // -------------------------------------------------------------------------
  // GET /dashboard/savings
  // -------------------------------------------------------------------------
  app.get('/savings', {
    schema: {
      tags: ['dashboard'],
      summary: 'Money saved and food rescued, by period',
      description:
        'Savings are attributed to the behaviour that produced them: waste the user did not ' +
        'throw away, cheaper store choices, and meals cooked from the pantry instead of ordering in.',
      querystring: jsonSchemaFrom(savingsPeriodSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const query = savingsPeriodSchema.parse(request.query ?? {});
    return ok(reply, await getSavingsStats(request.user!.id, query.period as StatsPeriod));
  });

  // -------------------------------------------------------------------------
  // GET /dashboard/expiring-soon
  // -------------------------------------------------------------------------
  app.get('/expiring-soon', {
    schema: {
      tags: ['dashboard'],
      summary: 'Items about to expire, each with a recipe suggestion',
      querystring: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 30, default: 5 } },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const { days } = request.query as { days?: string };
    return ok(reply, await getExpiringSoonItems(request.user!.id, Number(days ?? 5)));
  });

  // -------------------------------------------------------------------------
  // GET /dashboard/weekly-report
  // -------------------------------------------------------------------------
  app.get('/weekly-report', {
    schema: {
      tags: ['dashboard'],
      summary: 'Sunday 6 PM digest content',
      description:
        'The same payload the notification worker sends as the weekly report, so the app can ' +
        'render it as a screen rather than a dead-end push notification.',
      querystring: {
        type: 'object',
        properties: { week_start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    return ok(reply, await buildWeeklyReport(request.user!.id));
  });

  // -------------------------------------------------------------------------
  // GET /dashboard/trends — the charts on the Savings screen
  // -------------------------------------------------------------------------
  app.get('/trends', {
    schema: {
      tags: ['dashboard'],
      summary: 'Daily series for the savings, waste and pantry charts',
      querystring: jsonSchemaFrom(trendsQuerySchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const query = trendsQuerySchema.parse(request.query ?? {});
    return ok(reply, await getTrends(request.user!.id, query.days));
  });

  // -------------------------------------------------------------------------
  // GET /dashboard/recipe-of-the-day  ·  /dashboard/recent-recipes
  // -------------------------------------------------------------------------
  app.get('/recipe-of-the-day', {
    schema: {
      tags: ['dashboard'],
      summary: 'A stable pick for the day (same for every user until midnight UTC)',
      security: [],
      response: { 200: { type: 'object', properties: { data: { type: ['object', 'null'], additionalProperties: true } } } },
    },
  }, async (_request, reply) => ok(reply, await getRecipeOfTheDay()));

  app.get('/recent-recipes', {
    schema: {
      tags: ['dashboard'],
      summary: 'Recipes this user generated, cooked or saved most recently',
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 6 } },
      },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    return ok(reply, await getRecentRecipes(request.user!.id, Number(limit ?? 6)));
  });

  // -------------------------------------------------------------------------
  // GET /dashboard
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['dashboard'],
      summary: 'Full dashboard bundle (home + savings + subscription + expiry)',
      description:
        'One round-trip for the app\'s cold start. Heavier than `/dashboard/home`; use it for the ' +
        'initial hydration and the lighter endpoints for pull-to-refresh.',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getDashboard(request.user!.id)));
}
