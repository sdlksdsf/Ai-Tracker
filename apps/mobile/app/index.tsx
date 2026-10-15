import React, { useEffect } from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../stores/auth.store.js';
import { kv, StorageKeys } from '../lib/kv.js';

/**
 * Entry gate.
 *
 * Decides which stack the user lands in. The root layout has already resolved
 * `loading`, so by the time this renders the decision is final and there is no
 * flash between stacks.
 *
 * Onboarding is shown before the tabs whenever the account has not completed it
 * — including for an account created on another device, which is why the flag
 * comes from the server rather than from local storage alone.
 */
export default function Index(): React.ReactElement {
  const status = useAuthStore((state) => state.status);
  const onboardingCompleted = useAuthStore((state) => state.onboardingCompleted);

  const onboardingDismissed = kv.getBoolean(StorageKeys.onboardingSeen) ?? false;

  useEffect(() => {
    // Remember that this device has seen onboarding, so a user who skips it is
    // not asked again on every cold start.
    if (status === 'signedIn' && onboardingCompleted) {
      kv.setBoolean(StorageKeys.onboardingSeen, true);
    }
  }, [status, onboardingCompleted]);

  if (status === 'loading') return <Redirect href="/" />;

  if (status === 'signedOut') return <Redirect href="/(auth)/login" />;

  // Signed in but never finished setup, and not dismissed on this device.
  if (!onboardingCompleted && !onboardingDismissed) return <Redirect href="/onboarding" />;

  return <Redirect href="/(tabs)" />;
}
