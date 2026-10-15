import type { FastifyInstance } from 'fastify';
import type {
  ForgotPasswordInput,
  LoginInput,
  LogoutInput,
  OAuthAppleInput,
  OAuthGoogleInput,
  RefreshInput,
  RegisterInput,
  ResetPasswordInput,
} from '@platematch/shared';
import {
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  oauthAppleSchema,
  oauthGoogleSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from '@platematch/shared';
import { rateLimits } from '../lib/ratelimit.js';
import { jsonSchemaFrom, sessionResponse } from '../lib/openapi.js';
import { ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { track } from '../plugins/telemetry.js';
import { blockUserTokens } from '../plugins/auth.js';
import {
  countActiveSessions,
  login,
  logout,
  oauthApple,
  oauthGoogle,
  refresh,
  register,
  requestPasswordReset,
  resetPassword,
} from '../services/auth.service.js';

/**
 * Auth routes (Section 4 — `/auth/*`).
 *
 * Every mutation here is IP-rate-limited rather than user-limited, because at
 * this point there is no authenticated user yet.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /auth/register
  // -------------------------------------------------------------------------
  app.post('/register', {
    config: { rateLimit: rateLimits.auth() },
    schema: {
      tags: ['auth'],
      summary: 'Create an account with email + password',
      description: 'Hashes the password with Argon2id, seeds default nutrition targets and returns a session.',
      security: [],
      body: jsonSchemaFrom(registerSchema),
      response: { 201: sessionResponse() },
    },
  }, async (request, reply) => {
    const input = registerSchema.parse(request.body) as RegisterInput;
    const session = await register({
      email: input.email,
      password: input.password,
      full_name: input.full_name,
      timezone: input.timezone,
      locale: input.locale,
    });

    track('user_registered', session.user.id, { method: 'password', tier: session.user.subscription_tier });
    return ok(reply, session, 201);
  });

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------
  app.post('/login', {
    config: { rateLimit: rateLimits.auth() },
    schema: {
      tags: ['auth'],
      summary: 'Sign in with email + password',
      security: [],
      body: jsonSchemaFrom(loginSchema),
      response: { 200: sessionResponse() },
    },
  }, async (request, reply) => {
    const input = loginSchema.parse(request.body) as LoginInput;
    const session = await login({ email: input.email, password: input.password, fcmToken: input.fcm_token });
    track('user_logged_in', session.user.id, { method: 'password' });
    return ok(reply, session);
  });

  // -------------------------------------------------------------------------
  // POST /auth/refresh — rotating refresh tokens
  // -------------------------------------------------------------------------
  app.post('/refresh', {
    config: { rateLimit: rateLimits.auth(30) },
    schema: {
      tags: ['auth'],
      summary: 'Exchange a refresh token for a new access + refresh pair',
      description:
        'Refresh tokens rotate on every use and belong to a family. Presenting an already-rotated ' +
        'token revokes the whole family, which is how a stolen token is contained.',
      security: [],
      body: jsonSchemaFrom(refreshSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                access_token: { type: 'string' },
                refresh_token: { type: 'string' },
                token_type: { type: 'string' },
                expires_in: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = refreshSchema.parse(request.body) as RefreshInput;
    const result = await refresh(input.refresh_token);
    return ok(reply, {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  app.post('/logout', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['auth'],
      summary: 'Revoke the current refresh token (or the whole family)',
      body: jsonSchemaFrom(logoutSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { logged_out: { type: 'boolean' }, all_devices: { type: 'boolean' } } } } } },
    },
  }, async (request, reply) => {
    const input = logoutSchema.parse(request.body ?? {}) as LogoutInput;
    const userId = request.user!.id;

    await logout(userId, input.refresh_token);

    // No token supplied means "sign me out everywhere": revoke the refresh
    // families AND invalidate every access token minted before now.
    const allDevices = !input.refresh_token;
    if (allDevices) {
      await blockUserTokens(userId);
      logger.info({ userId }, 'All sessions revoked');
    }

    return ok(reply, { logged_out: true, all_devices: allDevices });
  });

  // -------------------------------------------------------------------------
  // GET /auth/sessions
  // -------------------------------------------------------------------------
  app.get('/sessions', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['auth'],
      summary: 'How many devices currently hold a valid refresh token',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'object', properties: { active_sessions: { type: 'integer' } } } },
        },
      },
    },
  }, async (request, reply) => ok(reply, { active_sessions: await countActiveSessions(request.user!.id) }));

  // -------------------------------------------------------------------------
  // POST /auth/forgot-password
  // -------------------------------------------------------------------------
  app.post('/forgot-password', {
    config: { rateLimit: rateLimits.passwordReset() },
    schema: {
      tags: ['auth'],
      summary: 'Request a password-reset link',
      description:
        'Always answers 200 with the same message so the endpoint cannot be used to discover ' +
        'which emails have an account. Outside production the token is returned for convenience.',
      security: [],
      body: jsonSchemaFrom(forgotPasswordSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { sent: { type: 'boolean' }, message: { type: 'string' }, token: { type: ['string', 'null'] } },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = forgotPasswordSchema.parse(request.body) as ForgotPasswordInput;
    const result = await requestPasswordReset(input.email);

    return ok(reply, {
      sent: true,
      message: 'If an account exists for that email, a reset link is on its way.',
      token: result.token ?? null,
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/reset-password
  // -------------------------------------------------------------------------
  app.post('/reset-password', {
    config: { rateLimit: rateLimits.passwordReset() },
    schema: {
      tags: ['auth'],
      summary: 'Set a new password with a reset token',
      description: 'Rotates the Argon2id hash and revokes every existing session for the account.',
      security: [],
      body: jsonSchemaFrom(resetPasswordSchema),
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { reset: { type: 'boolean' } } } } } },
    },
  }, async (request, reply) => {
    const input = resetPasswordSchema.parse(request.body) as ResetPasswordInput;
    const { userId } = await resetPasswordAndGetUser(input.token, input.password);
    await blockUserTokens(userId);
    return ok(reply, { reset: true });
  });

  // -------------------------------------------------------------------------
  // POST /auth/google  ·  POST /auth/apple
  // -------------------------------------------------------------------------
  app.post('/google', {
    config: { rateLimit: rateLimits.auth() },
    schema: {
      tags: ['auth'],
      summary: 'Sign in with a Google ID token',
      security: [],
      body: jsonSchemaFrom(oauthGoogleSchema),
      response: { 200: sessionResponse() },
    },
  }, async (request, reply) => {
    const input = oauthGoogleSchema.parse(request.body) as OAuthGoogleInput;
    const session = await oauthGoogle(input);
    track('user_logged_in', session.user.id, { method: 'google' });
    return ok(reply, session);
  });

  app.post('/apple', {
    config: { rateLimit: rateLimits.auth() },
    schema: {
      tags: ['auth'],
      summary: 'Sign in with an Apple identity token',
      security: [],
      body: jsonSchemaFrom(oauthAppleSchema),
      response: { 200: sessionResponse() },
    },
  }, async (request, reply) => {
    const input = oauthAppleSchema.parse(request.body) as OAuthAppleInput;
    const session = await oauthApple(input);
    track('user_logged_in', session.user.id, { method: 'apple' });
    return ok(reply, session);
  });
}

/** `resetPassword` returns void; we need the user id to revoke sessions. */
async function resetPasswordAndGetUser(token: string, newPassword: string): Promise<{ userId: string }> {
  const { parsePasswordResetToken } = await import('../lib/jwt.js');
  const { userId } = parsePasswordResetToken(token);
  await resetPassword(token, newPassword);
  return { userId };
}

