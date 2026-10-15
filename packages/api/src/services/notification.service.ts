import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  ListNotificationsQuery,
  NotificationDto,
  NotificationPreferencesInput,
  RegisterFcmTokenInput,
} from '@platematch/shared';
import { DEEP_LINK_ROUTES } from '@platematch/shared';
import { getDb } from '../db/index.js';
import {
  mealPlanEntries,
  mealPlans,
  notificationPreferences,
  notifications,
  pantryItems,
  recipeIngredients,
  recipes,
  userDevices,
  users,
  type NotificationPreference,
} from '../db/schema.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { fetchJson } from './ai/http.js';
import { daysUntilExpiry, expiryLabel, greetingForHour, hourInTimezone, todayInTimezone } from '../utils/dates.js';
import { normalizeIngredient, round2 } from '../utils/food.js';

/**
 * Notification service (Section 7).
 *
 * Delivery uses the Expo Push Service by default — it fans out to both APNs and
 * FCM and needs no server key, which makes local development trivial. Set
 * `FCM_SERVER_KEY` to send through Firebase directly instead.
 *
 * Every notification is ALSO written to the `notifications` inbox table so the
 * in-app bell works even when push is disabled or the token is stale.
 */

export type NotificationType =
  | 'expiry_alert'
  | 'meal_reminder'
  | 'weekly_report'
  | 'smart_suggestion'
  | 'achievement'
  | 'scan_complete'
  | 'system';

export interface SendNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  deepLink?: string | null;
  data?: Record<string, unknown>;
  /** Persist to the inbox even when push delivery fails (default true). */
  persist?: boolean;
  /** Skip push delivery (inbox-only notifications). */
  inboxOnly?: boolean;
}

export async function registerDeviceToken(
  userId: string,
  token: string,
  platform: RegisterFcmTokenInput['platform'] = 'android',
  deviceName?: string,
  appVersion?: string,
): Promise<{ registered: boolean }> {
  const db = getDb();
  await db
    .insert(userDevices)
    .values({ userId, pushToken: token, platform, deviceName, appVersion, lastSeenAt: new Date(), isActive: true })
    .onConflictDoUpdate({
      target: [userDevices.userId, userDevices.pushToken],
      set: { platform, deviceName, appVersion, lastSeenAt: new Date(), isActive: true },
    });

  // Mirror onto the preferences row for backwards compatibility with the spec.
  await db
    .insert(notificationPreferences)
    .values({ userId, fcmToken: token })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { fcmToken: token, updatedAt: new Date() } });

  return { registered: true };
}

export async function getDevices(userId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ token: userDevices.pushToken })
    .from(userDevices)
    .where(and(eq(userDevices.userId, userId), eq(userDevices.isActive, true)));
  return rows.map((r) => r.token);
}

export async function deactivateDevice(token: string): Promise<void> {
  const db = getDb();
  await db.update(userDevices).set({ isActive: false }).where(eq(userDevices.pushToken, token));
}

/** Send one notification: persist to the inbox, then push to every device. */
export async function sendNotification(input: SendNotificationInput): Promise<{ id: string; delivered: boolean }> {
  const db = getDb();

  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      type: input.type,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 1000),
      deepLink: input.deepLink ?? null,
      data: input.data ?? {},
      channel: input.inboxOnly ? 'inbox' : 'push',
      deliveryStatus: 'pending',
    })
    .returning();

  const id = (row as { id: string }).id;

  if (input.inboxOnly || !env.ENABLE_PUSH) {
    await db.update(notifications).set({ deliveryStatus: input.inboxOnly ? 'inbox_only' : 'disabled' }).where(eq(notifications.id, id));
    return { id, delivered: false };
  }

  const tokens = await getDevices(input.userId);
  if (!tokens.length) {
    await db.update(notifications).set({ deliveryStatus: 'no_device' }).where(eq(notifications.id, id));
    return { id, delivered: false };
  }

  const delivered = await pushToTokens(tokens, {
    title: input.title,
    body: input.body,
    data: { ...(input.data ?? {}), type: input.type, deepLink: input.deepLink ?? null, notificationId: id },
  });

  await db
    .update(notifications)
    .set({ deliveryStatus: delivered ? 'sent' : 'failed' })
    .where(eq(notifications.id, id));

  return { id, delivered };
}

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string;
  badge?: number;
}

/** Deliver through the Expo Push Service (or FCM legacy when a key is set). */
export async function pushToTokens(tokens: string[], payload: PushPayload): Promise<boolean> {
  if (!tokens.length) return false;

  try {
    if (env.FCM_SERVER_KEY) {
      return await pushViaFcm(tokens, payload);
    }
    return await pushViaExpo(tokens, payload);
  } catch (err) {
    logger.warn({ err: (err as Error).message, tokens: tokens.length }, 'Push delivery failed');
    return false;
  }
}

async function pushViaExpo(tokens: string[], payload: PushPayload): Promise<boolean> {
  // Expo accepts batches of up to 100 messages.
  const messages = tokens.map((to) => ({
    to,
    sound: payload.sound ?? 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    channelId: 'default',
    priority: 'high',
  }));

  const { data } = await fetchJson<{ data?: Array<{ status: string; message?: string; details?: { error?: string } }> }>(
    env.EXPO_PUSH_URL,
    {
      method: 'POST',
      body: messages,
      timeoutMs: 15_000,
      retries: 1,
      label: 'expo-push',
      allowErrorStatus: true,
    },
  );

  const results = data.data ?? [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result?.status === 'error' && result.details?.error === 'DeviceNotRegistered') {
      const token = tokens[i];
      if (token) await deactivateDevice(token);
    }
  }

  return results.some((r) => r?.status === 'ok');
}

async function pushViaFcm(tokens: string[], payload: PushPayload): Promise<boolean> {
  const { data } = await fetchJson<{ success?: number }>('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      authorization: `key=${env.FCM_SERVER_KEY}`,
      'content-type': 'application/json',
    },
    body: {
      registration_ids: tokens,
      notification: { title: payload.title, body: payload.body, sound: payload.sound ?? 'default' },
      data: Object.fromEntries(Object.entries(payload.data ?? {}).map(([k, v]) => [k, String(v)])),
      priority: 'high',
    },
    timeoutMs: 15_000,
    retries: 1,
    label: 'fcm',
  });
  return Number(data.success ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export async function listNotifications(userId: string, query: ListNotificationsQuery): Promise<{ data: NotificationDto[]; total: number }> {
  const db = getDb();
  const conditions = [eq(notifications.userId, userId)];
  if (query.unread_only) conditions.push(isNull(notifications.readAt));

  const where = and(...conditions);
  const limit = Math.min(50, Math.max(1, query.limit ?? 20));
  const page = Math.max(1, query.page ?? 1);

  const [rows, countRows] = await Promise.all([
    db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(limit).offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(where),
  ]);

  return {
    data: rows.map(notificationToDto),
    total: Number(countRows[0]?.count ?? 0),
  };
}

export function notificationToDto(row: typeof notifications.$inferSelect): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    deep_link: row.deepLink ?? null,
    data: (row.data ?? {}) as Record<string, unknown>,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function markNotificationsRead(userId: string, ids?: string[], all = false): Promise<{ updated: number }> {
  const db = getDb();
  const conditions = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (!all && ids?.length) conditions.push(sql`${notifications.id} = ANY(${ids})`);
  if (!all && !ids?.length) return { updated: 0 };

  const rows = await db.update(notifications).set({ readAt: new Date() }).where(and(...conditions)).returning({ id: notifications.id });
  return { updated: rows.length };
}

export async function countUnread(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getPreferences(userId: string): Promise<NotificationPreference> {
  const db = getDb();
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1);
  if (rows[0]) return rows[0] as NotificationPreference;

  const [created] = await db.insert(notificationPreferences).values({ userId }).returning();
  return created as NotificationPreference;
}

export async function updatePreferences(userId: string, input: NotificationPreferencesInput): Promise<NotificationPreference> {
  const db = getDb();
  await db.insert(notificationPreferences).values({ userId }).onConflictDoNothing({ target: notificationPreferences.userId });

  const [row] = await db
    .update(notificationPreferences)
    .set({
      expiryAlerts: input.expiry_alerts,
      mealReminders: input.meal_reminders,
      weeklyReports: input.weekly_reports,
      smartSuggestions: input.smart_suggestions,
      achievementAlerts: input.achievement_alerts,
      reminderBreakfastTime: input.reminder_breakfast_time,
      reminderLunchTime: input.reminder_lunch_time,
      reminderDinnerTime: input.reminder_dinner_time,
      digestHour: input.digest_hour,
      quietHoursStart: input.quiet_hours_start ?? null,
      quietHoursEnd: input.quiet_hours_end ?? null,
      updatedAt: new Date(),
    })
    .where(eq(notificationPreferences.userId, userId))
    .returning();

  return row as NotificationPreference;
}

/** True when a push would land inside the user's quiet hours. */
export function isQuietHour(prefs: NotificationPreference, timezone: string, now = new Date()): boolean {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;
  const hour = hourInTimezone(timezone, now);
  const [startH] = prefs.quietHoursStart.split(':').map(Number);
  const [endH] = prefs.quietHoursEnd.split(':').map(Number);
  if (startH == null || endH == null) return false;
  return startH <= endH ? hour >= startH && hour < endH : hour >= startH || hour < endH;
}

// ---------------------------------------------------------------------------
// Typed senders (Section 7 triggers)
// ---------------------------------------------------------------------------

/** Trigger 6 — scan complete (real-time). */
export async function sendScanCompleteNotification(userId: string, itemCount: number, scanId: string): Promise<void> {
  await sendNotification({
    userId,
    type: 'scan_complete',
    title: '✅ Fridge scan complete!',
    body: `Found ${itemCount} item${itemCount === 1 ? '' : 's'}. Tap to see recipes you can cook right now.`,
    deepLink: DEEP_LINK_ROUTES.scanResult(scanId),
    data: { scan_id: scanId, item_count: itemCount },
  });
}

/** Trigger 5 — achievement unlocked (real-time). */
export async function sendAchievementNotification(userId: string, name: string, description: string): Promise<void> {
  await sendNotification({
    userId,
    type: 'achievement',
    title: `🏆 New Badge: ${name}!`,
    body: description,
    deepLink: DEEP_LINK_ROUTES.achievements,
    data: { achievement: name },
  });
}

/** Trigger 1 — expiry alert (daily digest, 9 AM local). */
export async function sendExpiryAlerts(userId: string): Promise<number> {
  const db = getDb();
  const prefs = await getPreferences(userId);
  if (!prefs.expiryAlerts) return 0;

  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  if (user && isQuietHour(prefs, user.timezone)) return 0;

  const today = todayInTimezone(user?.timezone ?? 'UTC');
  const horizon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  const items = await db
    .select()
    .from(pantryItems)
    .where(
      and(
        eq(pantryItems.userId, userId),
        eq(pantryItems.isUsed, false),
        eq(pantryItems.isExpired, false),
        sql`${pantryItems.expiryDate} IS NOT NULL`,
        sql`${pantryItems.expiryDate} BETWEEN ${today} AND ${horizon}`,
      ),
    )
    .orderBy(sql`${pantryItems.expiryDate} ASC`)
    .limit(5);

  if (!items.length) return 0;

  const first = items[0]!;
  const days = daysUntilExpiry(first.expiryDate);
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;

  // Suggest a recipe that actually uses the item.
  const suggestion = await findRecipeUsing(userId, first.ingredientName);

  const body = suggestion
    ? `⚠️ Your ${first.ingredientName} expires ${when}! Try this: ${suggestion.title} (${suggestion.totalTimeMin ?? 25} min).`
    : `⚠️ Your ${first.ingredientName} expires ${when}${items.length > 1 ? ` — plus ${items.length - 1} more item(s)` : ''}. Cook it before it goes to waste!`;

  await sendNotification({
    userId,
    type: 'expiry_alert',
    title: items.length > 1 ? `⚠️ ${items.length} items expire soon` : '⚠️ Expiring soon',
    body,
    deepLink: suggestion ? DEEP_LINK_ROUTES.recipeDetail(suggestion.id) : DEEP_LINK_ROUTES.pantry,
    data: {
      item_ids: items.map((i) => i.id),
      item_names: items.map((i) => i.ingredientName),
      suggestion_recipe_id: suggestion?.id ?? null,
    },
  });

  return items.length;
}

async function findRecipeUsing(userId: string, ingredientName: string): Promise<{ id: string; title: string; totalTimeMin: number | null } | null> {
  const db = getDb();
  const key = normalizeIngredient(ingredientName);

  const rows = await db
    .select({ id: recipes.id, title: recipes.title, totalTimeMin: recipes.totalTimeMin })
    .from(recipes)
    .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
    .where(
      and(
        eq(recipeIngredients.normalizedKey, key),
        sql`(${recipes.ownerId} = ${userId} OR ${recipes.isPublic} = true)`,
      ),
    )
    .orderBy(desc(recipes.ratingAvg))
    .limit(1);

  return rows[0] ?? null;
}

/** Trigger 2 — meal reminder (30 min before each configured meal time). */
export async function sendMealReminder(userId: string, mealType: 'breakfast' | 'lunch' | 'dinner'): Promise<boolean> {
  const db = getDb();
  const prefs = await getPreferences(userId);
  if (!prefs.mealReminders) return false;

  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  const timezone = user?.timezone ?? 'UTC';
  if (isQuietHour(prefs, timezone)) return false;

  const today = todayInTimezone(timezone);

  const entry = await db
    .select({
      entryId: mealPlanEntries.id,
      dayOfWeek: mealPlanEntries.dayOfWeek,
      recipeId: mealPlanEntries.recipeId,
      title: recipes.title,
      totalTimeMin: recipes.totalTimeMin,
    })
    .from(mealPlanEntries)
    .innerJoin(mealPlans, eq(mealPlans.id, mealPlanEntries.mealPlanId))
    .leftJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(
      and(
        eq(mealPlanEntries.mealType, mealType),
        eq(mealPlanEntries.isCompleted, false),
        eq(mealPlans.userId, userId),
        eq(mealPlans.status, 'active'),
        sql`${mealPlans.weekStartDate} <= ${today}`,
        sql`${mealPlans.weekEndDate} >= ${today}`,
      ),
    )
    .limit(1);

  const planned = entry[0];
  const time =
    mealType === 'breakfast' ? prefs.reminderBreakfastTime : mealType === 'lunch' ? prefs.reminderLunchTime : prefs.reminderDinnerTime;

  if (planned?.title) {
    await sendNotification({
      userId,
      type: 'meal_reminder',
      title: `🍳 Time for ${mealType}!`,
      body: `Today's pick: ${planned.title} (${planned.totalTimeMin ?? 30} min)`,
      deepLink: planned.recipeId ? DEEP_LINK_ROUTES.cookingMode(planned.recipeId) : DEEP_LINK_ROUTES.plan,
      data: { meal_type: mealType, recipe_id: planned.recipeId, entry_id: planned.entryId, reminder_time: time },
    });
    return true;
  }

  await sendNotification({
    userId,
    type: 'meal_reminder',
    title: `🍳 ${mealType.charAt(0).toUpperCase() + mealType.slice(1)} time`,
    body: 'Nothing planned yet — open PlateMatch and pick something from your pantry.',
    deepLink: DEEP_LINK_ROUTES.recipes,
    data: { meal_type: mealType, reminder_time: time },
  });
  return true;
}

/** Trigger 3 — weekly report (Sunday 6 PM). */
export async function sendWeeklyReport(userId: string, stats: { savedUsd: number; wasteChangePct: number; mealsCooked: number }): Promise<void> {
  const prefs = await getPreferences(userId);
  if (!prefs.weeklyReports) return;

  await sendNotification({
    userId,
    type: 'weekly_report',
    title: '📊 Your weekly report',
    body: `You saved $${round2(stats.savedUsd).toFixed(2)}, changed waste by ${stats.wasteChangePct >= 0 ? '+' : ''}${stats.wasteChangePct}%, and cooked ${stats.mealsCooked} meal${stats.mealsCooked === 1 ? '' : 's'}! 🌱`,
    deepLink: DEEP_LINK_ROUTES.waste,
    data: stats,
  });
}

/** Trigger 4 — smart suggestion (daily 5 PM, only if the app was not opened). */
export async function sendSmartSuggestion(userId: string): Promise<boolean> {
  const db = getDb();
  const prefs = await getPreferences(userId);
  if (!prefs.smartSuggestions) return false;

  const [user] = await db
    .select({ timezone: users.timezone, lastActiveAt: users.lastActiveAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return false;

  const timezone = user.timezone ?? 'UTC';
  if (isQuietHour(prefs, timezone)) return false;

  // Only nudge users who have not opened the app in the last 24 hours.
  const hoursSinceActive = (Date.now() - user.lastActiveAt.getTime()) / 3_600_000;
  if (hoursSinceActive < 24) return false;

  const today = todayInTimezone(timezone);
  const horizon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  const expiring = await db
    .select({ id: pantryItems.id, name: pantryItems.ingredientName })
    .from(pantryItems)
    .where(
      and(
        eq(pantryItems.userId, userId),
        eq(pantryItems.isUsed, false),
        eq(pantryItems.isExpired, false),
        sql`${pantryItems.expiryDate} BETWEEN ${today} AND ${horizon}`,
      ),
    )
    .limit(3);

  if (!expiring.length) return false;

  const suggestion = await findRecipeUsing(userId, expiring[0]!.name);
  const names = expiring.map((e) => e.name).join(', ');

  await sendNotification({
    userId,
    type: 'smart_suggestion',
    title: '💡 Dinner idea',
    body: suggestion
      ? `You have ${names}. How about ${suggestion.title} tonight?`
      : `You have ${names} — cook something with them tonight before they expire!`,
    deepLink: suggestion ? DEEP_LINK_ROUTES.recipeDetail(suggestion.id) : DEEP_LINK_ROUTES.recipes,
    data: { recipe_id: suggestion?.id ?? null, ingredients: names },
  });

  return true;
}

/** Convenience for tests/tools: greeting for the dashboard header. */
export function greetingFor(timezone: string, name: string): string {
  return `${greetingForHour(hourInTimezone(timezone))}, ${name.split(' ')[0]}`;
}


