import { z } from 'zod';

export const timeString = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be HH:MM');

export const notificationPreferencesSchema = z.object({
  expiry_alerts: z.boolean().default(true),
  meal_reminders: z.boolean().default(true),
  weekly_reports: z.boolean().default(true),
  smart_suggestions: z.boolean().default(true),
  achievement_alerts: z.boolean().default(true),
  reminder_breakfast_time: timeString.default('07:30'),
  reminder_lunch_time: timeString.default('12:00'),
  reminder_dinner_time: timeString.default('18:30'),
  /** Hour (0-23) at which the daily expiry digest is delivered, in user local time. */
  digest_hour: z.number().int().min(0).max(23).default(9),
  quiet_hours_start: timeString.optional().nullable(),
  quiet_hours_end: timeString.optional().nullable(),
});
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

/**
 * What a client may send.
 *
 * Every field on the schema has a server-side default, so a partial body is
 * valid. `z.infer` describes the *parsed* shape (all defaults filled in), which
 * is what the API works with after validation — a client should not have to
 * invent values for settings it never surfaced.
 */
export type NotificationPreferencesRequest = z.input<typeof notificationPreferencesSchema>;

export const notificationDtoSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    'expiry_alert',
    'meal_reminder',
    'weekly_report',
    'smart_suggestion',
    'achievement',
    'scan_complete',
    'system',
  ]),
  title: z.string(),
  body: z.string(),
  /** Deep link the client should open (Expo Router path). */
  deep_link: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  read_at: z.string().nullable().optional(),
  created_at: z.string(),
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

export const listNotificationsQuerySchema = z.object({
  unread_only: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const registerFcmTokenSchema = z.object({
  fcm_token: z.string().trim().min(10).max(500),
  platform: z.enum(['ios', 'android', 'web']).default('android'),
  device_name: z.string().max(100).optional(),
  app_version: z.string().max(30).optional(),
});
export type RegisterFcmTokenInput = z.infer<typeof registerFcmTokenSchema>;

export const markNotificationReadSchema = z.object({
  ids: z.array(z.string().uuid()).max(100).optional(),
  all: z.boolean().default(false),
});
export type MarkNotificationReadInput = z.infer<typeof markNotificationReadSchema>;
