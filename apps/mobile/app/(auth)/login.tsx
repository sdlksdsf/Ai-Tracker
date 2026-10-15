import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Text } from '../../components/ui/Text.js';
import { Button } from '../../components/ui/Button.js';
import { Input } from '../../components/ui/Input.js';
import { Divider } from '../../components/ui/Screen.js';
import { useAuthStore } from '../../stores/auth.store.js';
import { useUiStore } from '../../stores/ui.store.js';
import { Centered } from '../../components/ui/Screen.js';

/**
 * Sign in (Screen 1).
 *
 * Validation runs through the same Zod schema the API uses, so the client cannot
 * accept something the server will reject — the user finds out before the round
 * trip, and the two error surfaces never disagree.
 */

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export default function LoginScreen(): React.ReactElement {
  const { t } = useTranslation('auth');
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const signIn = useAuthStore((state) => state.signIn);
  const pending = useAuthStore((state) => state.pending);
  const authError = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // A stale error from a previous attempt must not survive a screen change.
  useEffect(() => () => clearError(), [clearError]);

  const validate = (): boolean => {
    const result = loginSchema.safeParse({ email, password });
    if (result.success) {
      setFieldErrors({});
      return true;
    }

    const next: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const field = String(issue.path[0] ?? '');
      if (field && !next[field]) {
        next[field] = field === 'email' ? t('invalidEmail') : t('invalidPassword');
      }
    }
    setFieldErrors(next);
    return false;
  };

  const handleSubmit = async (): Promise<void> => {
    if (!validate()) {
      useUiStore.getState().warn();
      return;
    }

    const ok = await signIn(email.trim().toLowerCase(), password);
    if (ok) router.replace('/');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: spacing.lg,
          paddingTop: insets.top + spacing.xxl,
          paddingBottom: insets.bottom + spacing.xxl,
          gap: spacing.xl,
        }}
      >
        <Centered style={{ gap: spacing.xl }}>
          {/* Brand */}
          <View style={{ alignItems: 'center', gap: spacing.md }}>
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: radii.lg,
                backgroundColor: colors.primary,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="nutrition" size={40} color={colors.textInverse} />
            </View>
            <View style={{ alignItems: 'center', gap: 4 }}>
              <Text variant="displayMedium" align="center">
                {t('welcomeBack')}
              </Text>
              <Text variant="bodySmall" tone="secondary" align="center">
                {t('welcomeBackSub')}
              </Text>
            </View>
          </View>

          {/* Form */}
          <View style={{ width: '100%', gap: spacing.lg }}>
            <Input
              label={t('email')}
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: '' }));
              }}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              icon="mail-outline"
              error={fieldErrors.email}
              testID="login-email"
            />

            <Input
              label={t('password')}
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: '' }));
              }}
              placeholder="••••••••"
              secureToggle
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
              icon="lock-closed-outline"
              error={fieldErrors.password}
              onSubmitEditing={() => void handleSubmit()}
              returnKeyType="go"
              testID="login-password"
            />

            {authError ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.sm,
                  padding: spacing.md,
                  borderRadius: radii.sm,
                  backgroundColor: colors.dangerSoft,
                }}
              >
                <Ionicons name="alert-circle" size={sizes.iconSm} color={colors.danger} />
                <Text variant="caption" tone="danger" style={{ flex: 1 }} testID="login-error">
                  {authError}
                </Text>
              </View>
            ) : null}

            <Link href="/(auth)/forgot-password" asChild>
              <View style={{ alignSelf: 'flex-end' }}>
                <Text variant="caption" tone="primary">
                  {t('forgotPassword')}
                </Text>
              </View>
            </Link>

            <Button label={t('signIn')} onPress={() => void handleSubmit()} loading={pending} block size="lg" testID="login-submit" />
          </View>

          <Divider />

          {/* Register */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <Text variant="bodySmall" tone="secondary">
              {t('noAccount')}
            </Text>
            <Link href="/(auth)/register">
              <Text variant="bodyMedium" tone="primary">
                {t('signUp')}
              </Text>
            </Link>
          </View>
        </Centered>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
