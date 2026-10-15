import { create } from 'zustand';
import type { AuthSession, UserDto } from '@platematch/shared';
import { api, clearSession, onSessionExpired, refreshTokens } from '../lib/api.js';
import { secureStorage } from '../lib/secure-storage.js';
import { logger } from '../lib/logger.js';

/**
 * Auth store.
 *
 * Holds the signed-in user and the three-phase boot state the router depends on:
 *
 *   `loading`      → still reading tokens from the Keychain; render the splash
 *   `signedIn`     → a user is attached; show the tabs
 *   `signedOut`    → no session; show the auth screens
 *
 * The router must never guess between "signed out" and "haven't checked yet",
 * because that guess is what flashes a login screen at every cold start.
 */

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

export interface AuthState {
  status: AuthStatus;
  user: UserDto | null;
  /** Set once the onboarding flow has been completed for this account. */
  onboardingCompleted: boolean;
  /** True while a sign-in/sign-up request is in flight. */
  pending: boolean;
  /** Last error, surfaced inline on the auth forms. */
  error: string | null;

  /** Read stored tokens on boot and hydrate the user. */
  bootstrap(): Promise<void>;
  signIn(email: string, password: string): Promise<boolean>;
  signUp(input: { email: string; password: string; full_name: string; timezone?: string; locale?: string }): Promise<boolean>;
  signInWithGoogle(idToken: string): Promise<boolean>;
  signInWithApple(identityToken: string, opts?: { full_name?: string; email?: string }): Promise<boolean>;
  signOut(allDevices?: boolean): Promise<void>;
  /** Apply a refreshed user object after a profile edit. */
  setUser(user: UserDto): void;
  clearError(): void;
  /** Load the current profile, or null when the session is unusable. */
  fetchMe(): Promise<UserDto | null>;
}

function sessionToState(session: AuthSession): { user: UserDto; onboardingCompleted: boolean } {
  return { user: session.user, onboardingCompleted: session.user.onboarding_completed };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  onboardingCompleted: false,
  pending: false,
  error: null,

  async bootstrap() {
    try {
      const tokens = await secureStorage.getTokens();

      if (!tokens) {
        set({ status: 'signedOut', user: null, onboardingCompleted: false });
        return;
      }

      // Try the stored access token first — it is valid for 15 minutes, so a
      // warm start usually needs no network round-trip beyond /users/me.
      const user = await get().fetchMe();

      if (user) {
        set({ status: 'signedIn', user, onboardingCompleted: user.onboarding_completed });
        return;
      }

      // Access token expired: rotate and retry once.
      const refreshed = await refreshTokens();
      if (!refreshed) {
        await clearSession();
        set({ status: 'signedOut', user: null, onboardingCompleted: false });
        return;
      }

      const afterRefresh = await get().fetchMe();
      if (afterRefresh) {
        set({ status: 'signedIn', user: afterRefresh, onboardingCompleted: afterRefresh.onboarding_completed });
        return;
      }

      await clearSession();
      set({ status: 'signedOut', user: null, onboardingCompleted: false });
    } catch (err) {
      // An unreadable Keychain or a cold network must not lock the user out of
      // the app entirely — fall back to signed-out so they can sign in again.
      logger.warn('Auth bootstrap failed', err);
      set({ status: 'signedOut', user: null, onboardingCompleted: false });
    }
  },

  async signIn(email, password) {
    set({ pending: true, error: null });
    try {
      const session = await api.post<AuthSession>('/auth/login', { email, password });
      await secureStorage.setTokens({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      });
      const { user, onboardingCompleted } = sessionToState(session);
      set({ status: 'signedIn', user, onboardingCompleted, pending: false, error: null });
      return true;
    } catch (err) {
      set({ pending: false, error: errorMessage(err) });
      return false;
    }
  },

  async signUp(input) {
    set({ pending: true, error: null });
    try {
      const session = await api.post<AuthSession>('/auth/register', input, { anonymous: true });
      await secureStorage.setTokens({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      });
      const { user, onboardingCompleted } = sessionToState(session);
      set({ status: 'signedIn', user, onboardingCompleted, pending: false, error: null });
      return true;
    } catch (err) {
      set({ pending: false, error: errorMessage(err) });
      return false;
    }
  },

  async signInWithGoogle(idToken) {
    set({ pending: true, error: null });
    try {
      const session = await api.post<AuthSession>('/auth/google', { id_token: idToken }, { anonymous: true });
      return applySession(session, set);
    } catch (err) {
      set({ pending: false, error: errorMessage(err) });
      return false;
    }
  },

  async signInWithApple(identityToken, opts) {
    set({ pending: true, error: null });
    try {
      const session = await api.post<AuthSession>(
        '/auth/apple',
        { identity_token: identityToken, full_name: opts?.full_name, email: opts?.email },
        { anonymous: true },
      );
      return applySession(session, set);
    } catch (err) {
      set({ pending: false, error: errorMessage(err) });
      return false;
    }
  },

  async signOut(allDevices = false) {
    try {
      // Best effort: a failed revoke call must not strand the user signed in
      // locally with a token the server has already invalidated.
      await api.post('/auth/logout', allDevices ? {} : { refresh_token: await secureStorage.getRefreshToken() });
    } catch (err) {
      logger.warn('Logout request failed; clearing the local session anyway', err);
    } finally {
      await clearSession();
      set({ status: 'signedOut', user: null, onboardingCompleted: false, pending: false, error: null });
    }
  },

  setUser(user) {
    set({ user, onboardingCompleted: user.onboarding_completed });
  },

  clearError() {
    set({ error: null });
  },

  async fetchMe() {
    try {
      return await api.get<UserDto>('/users/me');
    } catch (err) {
      // A 401 here means the token is unusable; anything else (offline) should
      // not be treated as "signed out" by the caller, so we return null and let
      // bootstrap decide after a refresh attempt.
      logger.debug('fetchMe failed', err);
      return null;
    }
  },
}));

function applySession(session: AuthSession, set: (partial: Partial<AuthState>) => void): boolean {
  void secureStorage.setTokens({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  });
  const { user, onboardingCompleted } = sessionToState(session);
  set({ status: 'signedIn', user, onboardingCompleted, pending: false, error: null });
  return true;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'displayMessage' in err) {
    return String((err as { displayMessage: string }).displayMessage);
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Global session-expiry wiring
// ---------------------------------------------------------------------------

let wired = false;

/**
 * Connect the API client's session-expiry signal to the store.
 *
 * Called once from the root layout. Without it, a refresh token that dies while
 * the app is backgrounded leaves the UI showing cached data for a signed-out
 * account.
 */
export function wireSessionExpiry(): () => void {
  if (wired) return () => undefined;
  wired = true;

  return onSessionExpired(() => {
    useAuthStore.setState({ status: 'signedOut', user: null, onboardingCompleted: false, error: null });
  });
}
