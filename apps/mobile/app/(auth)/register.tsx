import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import * as Localization from 'expo-localization';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Text } from '../../components/ui/Text.js';
import { Button } from '../../components/ui/Button.js';
import { Input } from '../../components/ui/Input.js';
import { Divider, Centered } from '../../components/ui/Screen.js';
import { useAuthStore } from '../../stores/auth.store.js';
import { useUiStore } from '../../stores/ui.store.js';

/**
 * Create account (Screen 1).
 *
 * The device timezone and locale are captured here rather than defaulted on the
 * server: they drive the 9 AM expiry alerts and the number formatting, so a wrong
 * guess is felt immediately.
 */

const registerSchema = z
  .object({
    full_name: z.string().trim().min(1),
    email: z.string().trim().email(),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    confirm_password: z.string().min(1),
  })
  .refine((data) => data.password === data.confirm_password, {
    path: ['confirm_password'],
  });

/** Very rough strength meter — enough to steer, not to grade. */
function passwordStrength(password: string): { score: number; label: string; color: string } {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score <= 2) return { score, label: 'Weak', color: colors.danger };
  if (score === 3) return { score, label: 'Fair', color: colors.warning };
  if (score === 4) return { score, label: 'Good', color: colors.primaryLight };
  return { score, label: 'Strong', color: colors.success };
}

export default function RegisterScreen(): React.ReactElement {
  const { t } = useTranslation('auth');
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const signUp = useAuthStore((state) => state.signUp);
  const pending = useAuthStore((state) => state.pending);
  const authError = useAuthStore((state) => state.error);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const strength = passwordStrength(password);

  const handleSubmit = async (): Promise<void> => {
    const result = registerSchema.safeParse({ full_name: fullName, email, password, confirm_password: confirmPassword });

    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (!field || next[field]) continue;
        next[field] =
          field === 'full_name'
            ? t('nameRequired')
            : field === 'email'
              ? t('invalidEmail')
              : field === 'confirm_password'
                ? t('passwordMismatch')
                : t('invalidPassword');
      }
      setFieldErrors(next);
      useUiStore.getState().warn();
      return;
    }

    setFieldErrors({});

    const ok = await signUp({
      full_name: result.data.full_name,
      email: result.data.email.toLowerCase(),
      password: result.data.password,
      timezone: Localization.getCalendars()[0]?.timeZone ?? 'UTC',
      locale: Localization.getLocales()[0]?.languageTag ?? 'en',
    });

    if (ok) router.replace('/');
  };

  const setError = (field: string, value: string): void =>
    setFieldErrors((current) => ({ ...current, [field]: value }));

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
          <View style={{ alignItems: 'center', gap: spacing.xs }}>
            <Text variant="displayMedium" align="center">
              {t('getStarted')}
            </Text>
            <Text variant="bodySmall" tone="secondary" align="center" style={{ maxWidth: 320 }}>
              {t('getStartedSub')}
            </Text>
          </View>

          <View style={{ width: '100%', gap: spacing.lg }}>
            <Input
              label={t('fullName')}
              value={fullName}
              onChangeText={(value) => {
                setFullName(value);
                if (fieldErrors.full_name) setError('full_name', '');
              }}
              placeholder="Alex Morgan"
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              icon="person-outline"
              error={fieldErrors.full_name}
              testID="register-name"
            />

            <Input
              label={t('email')}
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                if (fieldErrors.email) setError('email', '');
              }}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              icon="mail-outline"
              error={fieldErrors.email}
              testID="register-email"
            />

            <View style={{ gap: spacing.xs }}>
              <Input
                label={t('password')}
                value={password}
                onChangeText={(value) => {
                  setPassword(value);
                  if (fieldErrors.password) setError('password', '');
                }}
                placeholder="••••••••"
                secureToggle
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                icon="lock-closed-outline"
                error={fieldErrors.password}
                hint={t('passwordHint')}
                testID="register-password"
              />

              {password.length > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <View style={{ flex: 1, flexDirection: 'row', gap: 4 }}>
                    {[0, 1, 2, 3, 4].map((index) => (
                      <View
                        key={index}
                        style={{
                          flex: 1,
                          height: 4,
                          borderRadius: radii.pill,
                          backgroundColor: index < strength.score ? strength.color : colors.divider,
                        }}
                      />
                    ))}
                  </View>
                  <Text variant="captionSmall" style={{ color: strength.color }}>
                    {strength.label}
                  </Text>
                </View>
              ) : null}
            </View>

            <Input
              label={t('confirmPassword')}
              value={confirmPassword}
              onChangeText={(value) => {
                setConfirmPassword(value);
                if (fieldErrors.confirm_password) setError('confirm_password', '');
              }}
              placeholder="••••••••"
              secureToggle
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              icon="lock-closed-outline"
              error={fieldErrors.confirm_password}
              onSubmitEditing={() => void handleSubmit()}
              returnKeyType="go"
              testID="register-confirm"
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
                <Text variant="caption" tone="danger" style={{ flex: 1 }} testID="register-error">
                  {authError}
                </Text>
              </View>
            ) : null}

            <Button label={t('signUp')} onPress={() => void handleSubmit()} loading={pending} block size="lg" testID="register-submit" />

            <Text variant="captionSmall" tone="tertiary" align="center" style={{ maxWidth: 340 }}>
              {t('termsNotice')}
            </Text>
          </View>

          <Divider />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <Text variant="bodySmall" tone="secondary">
              {t('haveAccount')}
            </Text>
            <Link href="/(auth)/login">
              <Text variant="bodyMedium" tone="primary">
                {t('signIn')}
              </Text>
            </Link>
          </View>
        </Centered>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
