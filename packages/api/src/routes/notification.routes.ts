import type { FastifyInstance } from 'fastify';
import type {
  ListNotificationsQuery,
  MarkNotificationReadInput,
  NotificationPreferencesInput,
  RegisterFcmTokenInput,
} from '@platematch/shared';
import {
  listNotificationsQuerySchema,
  markNotificationReadSchema,
  notificationPreferencesSchema,
  registerFcmTokenSchema,
} from '@platematch/shared';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { noContent, ok, pageParams, parseWith } from '../lib/http.js';
import { track } from '../plugins/telemetry.js';
import {
  countUnread,
  getPreferences,
  listNotifications,
  markNotificationsRead,
  registerDeviceToken,
  sendNotification,
  updatePreferences,
} from '../services/notification.service.js';

/**
 * Notification routes (Section 4 — `/notifications/*`, Section 7).
 *
 * Two channels share one inbox: push (Expo Push Service, or FCM when a server
 * key is configured) and the in-app bell. A notification is always written to
 * the inbox first, so a stale or missing device token degrades to "no push"
 * rather than "lost notification".
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // GET /notifications
  // -------------------------------------------------------------------------
  app.get('/', {
    schema: {
      tags: ['notifications'],
      summary: 'Inbox, newest first',
      querystring: jsonSchemaFrom(listNotificationsQuerySchema),
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
    const query = listNotificationsQuerySchema.parse(request.query ?? {}) as ListNotificationsQuery;
    const params = pageParams(query, { limit: 20, maxLimit: 50 });

    const result = await listNotifications(request.user!.id, { ...query, page: params.page, limit: params.limit });

    return reply.send({
      data: result.data,
      meta: {
        page: params.page,
        limit: params.limit,
        total: result.total,
        has_more: params.page * params.limit < result.total,
        next_cursor: null,
      },
    });
  });

  app.get('/unread-count', {
    schema: {
      tags: ['notifications'],
      summary: 'Badge count for the bell icon',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object', properties: { unread: { type: 'integer' } } } },
        },
      },
    },
  }, async (request, reply) => ok(reply, { unread: await countUnread(request.user!.id) }));

  // -------------------------------------------------------------------------
  // POST /notifications/read
  // -------------------------------------------------------------------------
  app.post('/read', {
    schema: {
      tags: ['notifications'],
      summary: 'Mark notifications as read (specific ids, or all)',
      body: jsonSchemaFrom(markNotificationReadSchema),
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object', properties: { updated: { type: 'integer' } } } },
        },
      },
    },
  }, async (request, reply) => {
    const input = markNotificationReadSchema.parse(request.body ?? {}) as MarkNotificationReadInput;
    const result = await markNotificationsRead(request.user!.id, input.ids, input.all ?? !input.ids?.length);
    return ok(reply, result);
  });

  // -------------------------------------------------------------------------
  // Device tokens
  // -------------------------------------------------------------------------
  app.post('/device', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      tags: ['notifications'],
      summary: 'Register a push token for this device',
      description:
        'Idempotent on (user, token): re-registering on app start just refreshes `last_seen_at` ' +
        'and re-activates a token the push provider previously reported as unregistered.',
      body: jsonSchemaFrom(registerFcmTokenSchema),
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object', properties: { registered: { type: 'boolean' } } } },
        },
      },
    },
  }, async (request, reply) => {
    const input = parseWith(registerFcmTokenSchema, request.body, 'device token') as RegisterFcmTokenInput;
    const result = await registerDeviceToken(
      request.user!.id,
      input.fcm_token,
      input.platform,
      input.device_name,
      input.app_version,
    );
    track('push_token_registered', request.user!.id, { platform: input.platform });
    return ok(reply, result);
  });

  app.delete('/device/:token', {
    schema: {
      tags: ['notifications'],
      summary: 'Unregister a push token (sign-out on this device)',
      params: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { deactivateDevice } = await import('../services/notification.service.js');
    await deactivateDevice(decodeURIComponent(token));
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------
  app.get('/preferences', {
    schema: {
      tags: ['notifications'],
      summary: 'Current notification preferences and reminder times',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    return ok(reply, preferencesToDto(await getPreferences(request.user!.id)));
  });

  app.put('/preferences', {
    schema: {
      tags: ['notifications'],
      summary: 'Update notification preferences',
      description:
        'Quiet hours are honoured by every scheduled trigger, so a 9 AM expiry alert is skipped ' +
        'for a user who set 22:00–08:00.',
      body: jsonSchemaFrom(notificationPreferencesSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(notificationPreferencesSchema, request.body, 'preferences') as NotificationPreferencesInput;
    const prefs = await updatePreferences(request.user!.id, input);
    track('notification_preferences_updated', request.user!.id, {
      expiry: prefs.expiryAlerts,
      reminders: prefs.mealReminders,
    });
    return ok(reply, preferencesToDto(prefs));
  });
}

/** Row → wire shape, shared by the GET and PUT handlers. */
function preferencesToDto(prefs: {
  expiryAlerts: boolean;
  mealReminders: boolean;
  weeklyReports: boolean;
  smartSuggestions: boolean;
  achievementAlerts: boolean;
  reminderBreakfastTime: string;
  reminderLunchTime: string;
  reminderDinnerTime: string;
  digestHour: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}) {
  return {
    expiry_alerts: prefs.expiryAlerts,
    meal_reminders: prefs.mealReminders,
    weekly_reports: prefs.weeklyReports,
    smart_suggestions: prefs.smartSuggestions,
    achievement_alerts: prefs.achievementAlerts,
    reminder_breakfast_time: prefs.reminderBreakfastTime,
    reminder_lunch_time: prefs.reminderLunchTime,
    reminder_dinner_time: prefs.reminderDinnerTime,
    digest_hour: prefs.digestHour,
    quiet_hours_start: prefs.quietHoursStart,
    quiet_hours_end: prefs.quietHoursEnd,
  };
}

/** Exposed for the worker: enqueue a one-off system notification. */
export async function sendSystemNotification(userId: string, title: string, body: string): Promise<void> {
  await sendNotification({ userId, type: 'system', title, body });
}
