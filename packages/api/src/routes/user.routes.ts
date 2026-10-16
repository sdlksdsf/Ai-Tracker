import type { FastifyInstance } from 'fastify';
import type {
  AllergyInput,
  NutritionTargetsInput,
  OnboardingInput,
  UpdatePreferencesInput,
  UpdateProfileInput,
} from '@platematch/shared';
import {
  allergySchema,
  onboardingSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from '@platematch/shared';
import { z } from 'zod';
import { jsonSchemaFrom } from '../lib/openapi.js';
import { noContent, ok, parseWith } from '../lib/http.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { uploadAvatar } from '../lib/storage.js';
import { preprocessImage, validateImageInput } from '../lib/image.js';
import { track } from '../plugins/telemetry.js';
import { blockUserTokens } from '../plugins/auth.js';
import { verifyPassword, hashPassword } from '../lib/crypto.js';
import {
  addAllergy,
  deleteAccount,
  getAllergies,
  getUserById,
  getUserDto,
  recalculateTargets,
  removeAllergy,
  setAvatarUrl,
  updatePreferences,
  updateProfile,
} from '../services/user.service.js';
import { getSubscriptionStatus } from '../services/subscription.service.js';

/**
 * User routes (Section 4 — `/users/*`).
 *
 * All of them require a valid access token; the full user row is attached by
 * the `withUser` preHandler so handlers never repeat the lookup.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  // Every route below is authenticated.
  app.addHook('preHandler', app.authenticate);

  // -------------------------------------------------------------------------
  // GET /users/me
  // -------------------------------------------------------------------------
  app.get('/me', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Current profile, preferences, allergies and nutrition targets',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getUserDto(request.user!.id)));

  // -------------------------------------------------------------------------
  // PATCH /users/me
  // -------------------------------------------------------------------------
  app.patch('/me', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Update profile fields (name, height, weight, goal, budget, …)',
      body: jsonSchemaFrom(updateProfileSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(updateProfileSchema, request.body, 'profile') as UpdateProfileInput;
    const dto = await updateProfile(request.user!.id, input);
    track('profile_updated', dto.id, { fields: Object.keys(input) });
    return ok(reply, dto);
  });

  // -------------------------------------------------------------------------
  // PUT /users/me/preferences — also used as the onboarding submit
  // -------------------------------------------------------------------------
  app.put('/me/preferences', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Save dietary preferences, allergies and cooking constraints',
      description:
        'Replaces the allergy list wholesale and recomputes the daily calorie/macro targets from ' +
        'the Mifflin–St Jeor equation. This is the endpoint the onboarding flow calls.',
      body: jsonSchemaFrom(updatePreferencesSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(updatePreferencesSchema, request.body, 'preferences') as UpdatePreferencesInput;
    const dto = await updatePreferences(request.user!.id, input);
    track('preferences_updated', dto.id, {
      diet: dto.dietary_preference,
      allergies: dto.allergies.length,
      goal: dto.health_goal,
    });
    return ok(reply, dto);
  });

  app.post('/me/onboarding', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Complete onboarding (preferences + mark the flag)',
      body: jsonSchemaFrom(onboardingSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(onboardingSchema, request.body, 'onboarding') as OnboardingInput;
    const dto = await updatePreferences(request.user!.id, input);
    track('onboarding_completed', dto.id, { diet: dto.dietary_preference });
    return ok(reply, dto);
  });

  // -------------------------------------------------------------------------
  // Allergies
  // -------------------------------------------------------------------------
  const addAllergySchema = allergySchema.extend({ allergen: z.string().trim().min(1).max(60) });

  app.post('/me/allergies', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Add an allergy (drives the hard allergen-safety filter)',
      body: jsonSchemaFrom(addAllergySchema),
      response: { 201: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const input = parseWith(addAllergySchema, request.body, 'allergy') as AllergyInput;
    const row = await addAllergy(request.user!.id, input.allergen, input.severity);
    return ok(reply, { id: row.id, allergen: row.allergen, severity: row.severity, created_at: row.createdAt.toISOString() }, 201);
  });

  app.get('/me/allergies', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'List saved allergies',
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const rows = await getAllergies(request.user!.id);
    return ok(reply, rows.map((r) => ({ id: r.id, allergen: r.allergen, severity: r.severity, created_at: r.createdAt.toISOString() })));
  });

  app.delete('/me/allergies/:allergyId', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Remove an allergy',
      params: { type: 'object', properties: { allergyId: { type: 'string', format: 'uuid' } }, required: ['allergyId'] },
    },
  }, async (request, reply) => {
    const { allergyId } = request.params as { allergyId: string };
    await removeAllergy(request.user!.id, allergyId);
    return noContent(reply);
  });

  // -------------------------------------------------------------------------
  // Nutrition targets
  // -------------------------------------------------------------------------
  app.get('/me/nutrition-targets', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Recomputed daily calorie + macro targets',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const user = await getUserById(request.user!.id);
    if (!user) throw new NotFoundError('User not found');
    return ok(reply, await recalculateTargets(request.user!.id, user) as NutritionTargetsInput);
  });

  // -------------------------------------------------------------------------
  // Avatar upload
  // -------------------------------------------------------------------------
  app.post('/me/avatar', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Upload a profile photo (multipart, field `image`)',
      consumes: ['multipart/form-data'],
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const upload = await request.readImageUpload('image');
    validateImageInput(upload.buffer, upload.mimeType);
    const processed = await preprocessImage(upload.buffer, { maxSide: 512 });
    const stored = await uploadAvatar(request.user!.id, processed.buffer, processed.mimeType);
    const dto = await setAvatarUrl(request.user!.id, stored.url);
    return ok(reply, dto);
  });

  // -------------------------------------------------------------------------
  // Subscription snapshot (convenience mirror of /subscription/status)
  // -------------------------------------------------------------------------
  app.get('/me/subscription', {
    preHandler: [app.withUser],
    schema: {
      tags: ['users'],
      summary: 'Plan, limits and usage for the signed-in user',
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => ok(reply, await getSubscriptionStatus(request.user!.id)));

  // -------------------------------------------------------------------------
  // Password change
  // -------------------------------------------------------------------------
  const changePasswordSchema = z.object({
    current_password: z.string().min(1, 'Current password is required'),
    new_password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  });

  app.post('/me/change-password', {
    preHandler: [app.withUser],
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      tags: ['users'],
      summary: 'Change the account password',
      description: 'Re-hashes with Argon2id and revokes every existing session.',
      body: jsonSchemaFrom(changePasswordSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { current_password: currentPassword, new_password: newPassword } = changePasswordSchema.parse(request.body);
    const userId = request.user!.id;
    const user = await getUserById(userId);

    if (!user) throw new NotFoundError('User not found');
    // OAuth-only accounts have no password to compare against.
    if (!user.passwordHash) {
      throw new BadRequestError('This account signs in with Google or Apple. Set a password using the reset flow.');
    }
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new BadRequestError('Your current password is incorrect.');
    }

    const { getDb } = await import('../db/index.js');
    const { users } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');

    await getDb().update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, userId));
    await blockUserTokens(userId);
    track('password_changed', userId, {});

    return ok(reply, { changed: true, sessions_revoked: true });
  });

  // -------------------------------------------------------------------------
  // DELETE /users/me — GDPR-style account deletion
  // -------------------------------------------------------------------------
  app.delete('/me', {
    preHandler: [app.withUser],
    config: { rateLimit: { max: 3, timeWindow: '1 day' } },
    schema: {
      tags: ['users'],
      summary: 'Delete the account and every row that belongs to it',
      description:
        'Deletes the user row and, through ON DELETE CASCADE, every row that references it: pantry, ' +
        'scans, plans, lists, waste logs, ratings, favourites and sessions. Recipes they authored are ' +
        'kept with their owner detached, and historic AI usage rows are anonymised rather than ' +
        'deleted. All sessions are revoked immediately.',
    },
  }, async (request, reply) => {
    const userId = request.user!.id;
    await deleteAccount(userId);
    await blockUserTokens(userId);
    track('account_deleted', userId, {});
    return noContent(reply);
  });
}
