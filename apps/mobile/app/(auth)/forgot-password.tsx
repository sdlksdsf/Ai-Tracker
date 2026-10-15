import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Button } from '../../components/ui/Button.js';
import { Input } from '../../components/ui/Input.js';
import { useRequestPasswordReset } from '../../hooks/useApi.js';

/**
 * Password reset request.
 *
 * The API always answers 200 with the same message so the endpoint cannot be
 * used to discover which emails have an account. This screen therefore never
 * says "we sent you an email" as a confirmation of existence — it says what the
 * server said, and offers the reset form for the token that arrives.
 */

const emailSchema = z.string().trim().email();
const resetSchema = z.object({ token: z.string().min(10), password: z.string().min(8) });

export default function ForgotPasswordScreen(): React.ReactElement {
  const { t } = useTranslation('auth');
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  // Second step: exchange the emailed token for a new password.
  const [showReset, setShowReset] = useState(false);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  const requestReset = useRequestPasswordReset();
  const [resetting, setResetting] = useState(false);

  const handleRequest = async (): Promise<void> => {
    if (!emailSchema.safeParse(email).success) {
      setEmailError(t('invalidEmail'));
      return;
    }
    setEmailError(null);

    try {
      const result = await requestReset.mutateAsync(email.trim().toLowerCase());
      setSentMessage(result.message);
      setShowReset(true);
    } catch (error) {
      setSentMessage((error as Error).message);
    }
  };

  const handleReset = async (): Promise<void> => {
    if (!resetSchema.safeParse({ token, password }).success) {
      setResetError(t('invalidPassword'));
      return;
    }
    setResetError(null);
    setResetting(true);

    try {
      // Dynamic import keeps this rarely-used path out of the initial bundle.
      const { api } = await import('../../lib/api.js');
      await api.post('/auth/reset-password', { token: token.trim(), password }, { anonymous: true });
      router.replace('/(auth)/login');
    } catch (error) {
      setResetError((error as Error).message);
      setResetting(false);
    }
  };

  return (
    <Screen
      header={{ title: t('resetPassword'), back: true, onBack: () => router.back() }}
      keyboardAvoiding
      testID="forgot-password-screen"
    >
      <View style={{ gap: spacing.lg }}>
        <Text variant="bodySmall" tone="secondary">
          Enter the email you signed up with and we will send a link to set a new password.
        </Text>

        <Input
          label={t('email')}
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          icon="mail-outline"
          error={emailError}
          onSubmitEditing={() => void handleRequest()}
          returnKeyType="send"
          testID="reset-email"
        />

        <Button label={t('sendResetLink')} onPress={() => void handleRequest()} loading={requestReset.isPending} block testID="reset-submit" />

        {sentMessage ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: spacing.sm,
              padding: spacing.md,
              borderRadius: radii.sm,
              backgroundColor: colors.primarySoft,
            }}
            testID="reset-sent"
          >
            <Ionicons name="mail-outline" size={sizes.iconSm} color={colors.primary} />
            <Text variant="caption" tone="primary" style={{ flex: 1 }}>
              {sentMessage}
            </Text>
          </View>
        ) : null}
      </View>

      {showReset ? (
        <View style={{ gap: spacing.lg }}>
          <Text variant="headingSmall">Enter your new password</Text>

          <Input
            label="Reset token"
            value={token}
            onChangeText={setToken}
            placeholder="Paste the token from the email"
            autoCapitalize="none"
            autoCorrect={false}
            icon="key-outline"
            testID="reset-token"
          />

          <Input
            label={t('newPassword')}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureToggle
            autoCapitalize="none"
            autoComplete="new-password"
            icon="lock-closed-outline"
            error={resetError}
            hint={t('passwordHint')}
            onSubmitEditing={() => void handleReset()}
            returnKeyType="go"
            testID="reset-new-password"
          />

          <Button label={t('resetPassword')} onPress={() => void handleReset()} loading={resetting} block testID="reset-confirm" />

          <Text variant="captionSmall" tone="tertiary">
            Resetting your password signs you out on every device.
          </Text>
        </View>
      ) : null}
    </Screen>
  );
}
