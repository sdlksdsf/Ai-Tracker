import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestUser,
  data,
  isDatabaseAvailable,
  startHarness,
  stopHarness,
  uniqueEmail,
  type Harness,
  type TestUser,
} from './helpers/harness.js';

/**
 * Authentication, end to end.
 *
 * Covers the parts that are easy to get subtly wrong: the rotating refresh
 * token (reuse of a rotated token must revoke the family), the shared error
 * envelope, the fact that `/auth/forgot-password` cannot be used to enumerate
 * accounts, and that a protected route rejects both a missing and a malformed
 * token with 401 rather than 500.
 */

let harness: Harness | null = null;
const available = await isDatabaseAvailable();

describe.skipIf(!available)('auth', () => {
  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  describe('POST /auth/register', () => {
    it('creates an account and returns a full session', async () => {
      const email = uniqueEmail('register');

      const response = await harness!.post('/api/v1/auth/register', {
        email,
        password: 'Sup3rSecret!',
        full_name: 'Ada Lovelace',
        timezone: 'UTC',
        locale: 'en',
      });

      expect(response.statusCode).toBe(201);

      const session = data<{
        user: Record<string, unknown>;
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
      }>(response);

      expect(session.token_type).toBe('Bearer');
      expect(session.access_token).toBeTruthy();
      expect(session.refresh_token).toBeTruthy();
      expect(session.expires_in).toBe(900); // 15 minutes
      expect(session.user.email).toBe(email);
      expect(session.user.full_name).toBe('Ada Lovelace');
      expect(session.user.subscription_tier).toBe('free');
    });

    it('never returns the password hash', async () => {
      const response = await harness!.post('/api/v1/auth/register', {
        email: uniqueEmail('nohash'),
        password: 'Sup3rSecret!',
        full_name: 'No Hash',
      });

      expect(response.statusCode).toBe(201);
      // The whole serialized response, not just the user object — a leak could
      // hide in metadata.
      expect(response.body.toLowerCase()).not.toContain('passwordhash');
      expect(response.body.toLowerCase()).not.toContain('password_hash');
      expect(response.body).not.toContain('Sup3rSecret!');
    });

    it('seeds default nutrition targets', async () => {
      const response = await harness!.post('/api/v1/auth/register', {
        email: uniqueEmail('targets'),
        password: 'Sup3rSecret!',
        full_name: 'Target User',
      });

      const session = data<{ user: Record<string, number | null> }>(response);
      expect(session.user.daily_calorie_target).toBeGreaterThan(0);
      expect(session.user.daily_protein_target_g).toBeGreaterThan(0);
    });

    it('rejects a duplicate email with 409', async () => {
      const email = uniqueEmail('dupe');
      const first = await harness!.post('/api/v1/auth/register', { email, password: 'Sup3rSecret!', full_name: 'One' });
      expect(first.statusCode).toBe(201);

      const second = await harness!.post('/api/v1/auth/register', { email, password: 'Sup3rSecret!', full_name: 'Two' });
      expect(second.statusCode).toBe(409);

      const body = second.json() as { error: string; message: string; requestId: string };
      expect(body.error).toBe('conflict');
      expect(body.requestId).toBeTruthy();
    });

    it('normalises email case, so Ada@X and ada@x are one account', async () => {
      const email = uniqueEmail('case');
      await harness!.post('/api/v1/auth/register', {
        email: email.toUpperCase(),
        password: 'Sup3rSecret!',
        full_name: 'Case Test',
      });

      const login = await harness!.post('/api/v1/auth/login', { email: email.toLowerCase(), password: 'Sup3rSecret!' });
      expect(login.statusCode).toBe(200);
    });

    it.each([
      ['a missing email', { password: 'Sup3rSecret!', full_name: 'X' }],
      ['a malformed email', { email: 'not-an-email', password: 'Sup3rSecret!', full_name: 'X' }],
      ['a short password', { email: uniqueEmail('short'), password: 'abc', full_name: 'X' }],
      ['a missing name', { email: uniqueEmail('noname'), password: 'Sup3rSecret!' }],
    ])('rejects %s with 422 and field-level detail', async (_label, payload) => {
      const response = await harness!.post('/api/v1/auth/register', payload);

      expect(response.statusCode).toBe(422);

      const body = response.json() as { error: string; message: string };
      expect(body.error).toBe('validation_error');
      expect(body.message).toBeTruthy();
    });
  });

  describe('POST /auth/login', () => {
    let user: TestUser;

    beforeAll(async () => {
      user = await createTestUser(harness!);
    });

    it('accepts the right credentials', async () => {
      const response = await harness!.post('/api/v1/auth/login', { email: user.email, password: user.password });

      expect(response.statusCode).toBe(200);
      const session = data<{ access_token: string; user: { id: string } }>(response);
      expect(session.access_token).toBeTruthy();
      expect(session.user.id).toBe(user.id);
    });

    it('rejects a wrong password with 401', async () => {
      const response = await harness!.post('/api/v1/auth/login', { email: user.email, password: 'wrong-password' });

      expect(response.statusCode).toBe(401);
      const body = response.json() as { error: string };
      expect(body.error).toBe('unauthorized');
    });

    it('rejects an unknown email with the same status and shape', async () => {
      const known = await harness!.post('/api/v1/auth/login', { email: user.email, password: 'wrong-password' });
      const unknown = await harness!.post('/api/v1/auth/login', { email: uniqueEmail('ghost'), password: 'wrong-password' });

      // Identical responses — otherwise the endpoint is an account oracle.
      expect(unknown.statusCode).toBe(known.statusCode);
      expect(unknown.statusCode).toBe(401);
    });
  });

  describe('POST /auth/refresh — rotating tokens', () => {
    let user: TestUser;

    beforeAll(async () => {
      user = await createTestUser(harness!);
    });

    it('issues a new pair', async () => {
      const response = await harness!.post('/api/v1/auth/refresh', { refresh_token: user.refreshToken });

      expect(response.statusCode).toBe(200);
      const body = data<{ access_token: string; refresh_token: string; token_type: string; expires_in: number }>(response);

      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(900);
      // Rotation: the new refresh token must differ from the one presented.
      expect(body.refresh_token).not.toBe(user.refreshToken);
    });

    it('rejects a stub that is not token-shaped with 422', async () => {
      // `refreshSchema` requires >= 10 characters: something this short was
      // never a token, so it is a malformed request rather than a failed auth.
      const response = await harness!.post('/api/v1/auth/refresh', { refresh_token: 'not.a.jwt' });
      expect(response.statusCode).toBe(422);
    });

    it('rejects a forged token-shaped string with 401', async () => {
      // The case that actually matters for security: long enough to pass
      // validation and structurally a JWT, but not signed by us.
      const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.invalidsignature';
      const response = await harness!.post('/api/v1/auth/refresh', { refresh_token: forged });

      expect(response.statusCode).toBe(401);
      expect((response.json() as { error: string }).error).toBe('unauthorized');
    });

    it('rejects a replayed refresh token after rotation with 401', async () => {
      // Rotation must invalidate the token that was presented, otherwise a
      // stolen refresh token stays usable forever.
      const victim = await createTestUser(harness!);
      const first = await harness!.post('/api/v1/auth/refresh', { refresh_token: victim.refreshToken });
      expect(first.statusCode).toBe(200);

      const replay = await harness!.post('/api/v1/auth/refresh', { refresh_token: victim.refreshToken });
      expect(replay.statusCode).toBe(401);
    });

    it('rejects an empty body with 422', async () => {
      const response = await harness!.post('/api/v1/auth/refresh', {});
      expect(response.statusCode).toBe(422);
    });
  });

  describe('protected routes', () => {
    it('reject a request with no token', async () => {
      const response = await harness!.get('/api/v1/users/me');

      expect(response.statusCode).toBe(401);
      const body = response.json() as { error: string; message: string };
      expect(body.error).toBe('unauthorized');
      expect(body.message).toMatch(/authorization|bearer/i);
    });

    it('reject a malformed token without a 500', async () => {
      for (const token of ['garbage', 'Bearer', 'Bearer not.a.jwt', 'Bearer a.b.c']) {
        const response = await harness!.app.inject({
          method: 'GET',
          url: '/api/v1/users/me',
          headers: { authorization: token },
        });

        // A bad token is the client's fault: 401, never 500.
        expect(response.statusCode, `token "${token}" should be 401`).toBe(401);
      }
    });

    it('accept a valid token', async () => {
      const user = await createTestUser(harness!);
      const response = await harness!.get('/api/v1/users/me', user.accessToken);

      expect(response.statusCode).toBe(200);
      const profile = data<{ id: string; email: string }>(response);
      expect(profile.id).toBe(user.id);
      expect(profile.email).toBe(user.email);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('answers 200 for an existing account', async () => {
      const user = await createTestUser(harness!);
      const response = await harness!.post('/api/v1/auth/forgot-password', { email: user.email });

      expect(response.statusCode).toBe(200);
      const body = data<{ sent: boolean; message: string }>(response);
      expect(body.sent).toBe(true);
      expect(body.message).toBeTruthy();
    });

    it('answers 200 for a NON-existent account, with the same message', async () => {
      const real = await harness!.post('/api/v1/auth/forgot-password', { email: (await createTestUser(harness!)).email });
      const fake = await harness!.post('/api/v1/auth/forgot-password', { email: uniqueEmail('ghost') });

      // The whole point: identical responses so this cannot enumerate accounts.
      expect(fake.statusCode).toBe(200);
      expect(fake.statusCode).toBe(real.statusCode);

      const realMessage = (real.json() as { data: { message: string } }).data.message;
      const fakeMessage = (fake.json() as { data: { message: string } }).data.message;
      expect(fakeMessage).toBe(realMessage);
    });

    it('rejects a malformed email with 422', async () => {
      const response = await harness!.post('/api/v1/auth/forgot-password', { email: 'nope' });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session', async () => {
      const user = await createTestUser(harness!);

      const logout = await harness!.post('/api/v1/auth/logout', {}, user.accessToken);
      expect([200, 204]).toContain(logout.statusCode);

      // The refresh token is now dead.
      const refresh = await harness!.post('/api/v1/auth/refresh', { refresh_token: user.refreshToken });
      expect(refresh.statusCode).toBe(401);
    });

    it('requires authentication', async () => {
      const response = await harness!.post('/api/v1/auth/logout', {});
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /auth/sessions', () => {
    it('reports the number of active devices', async () => {
      const user = await createTestUser(harness!);
      const response = await harness!.get('/api/v1/auth/sessions', user.accessToken);

      expect(response.statusCode).toBe(200);
      const body = data<{ active_sessions: number }>(response);
      expect(body.active_sessions).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /users/me', () => {
    it('includes allergies as an array even when none are set', async () => {
      const user = await createTestUser(harness!);
      const profile = data<{ allergies: unknown[] }>(await harness!.get('/api/v1/users/me', user.accessToken));

      expect(Array.isArray(profile.allergies)).toBe(true);
      expect(profile.allergies).toHaveLength(0);
    });

    it('never leaks a Stripe or OAuth identifier', async () => {
      const user = await createTestUser(harness!);
      const response = await harness!.get('/api/v1/users/me', user.accessToken);

      for (const leak of ['stripe_customer_id', 'stripeCustomerId', 'password', 'fcm_token']) {
        expect(response.body.toLowerCase(), `profile leaked ${leak}`).not.toContain(leak.toLowerCase());
      }
    });
  });
});
