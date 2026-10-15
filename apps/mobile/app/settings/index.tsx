import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { colors, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { SwitchRow, SettingsGroup } from './_components.js';
import { OptionSheet, type SheetOption } from '../../components/ui/Sheet.js';
import { useUiStore } from '../../stores/ui.store.js';
import { SUPPORTED_LOCALES, changeLocale } from '../../i18n/index.js';
import { kv, StorageKeys, isPersistent } from '../../lib/kv.js';
import { config } from '../../lib/config.js';
import { toast } from '../../stores/ui.store.js';

/**
 * Settings (Section 6, Screen 15).
 *
 * Grouped into General (language, units, haptics), Notifications, Data and About.
 * The developer section is only rendered in a dev build, where the API base URL
 * and AI provider status are the two things worth checking first.
 */

export default function SettingsScreen(): React.ReactElement {
  const { t, i18n } = useTranslation('settings');
  const router = useRouter();

  const hapticsEnabled = useUiStore((state) => state.hapticsEnabled);
  const setHaptics = useUiStore((state) => state.setHaptics);

  const [units, setUnits] = useState<'metric' | 'imperial'>(kv.get('app:units') === 'imperial' ? 'imperial' : 'metric');
  const [showLanguage, setShowLanguage] = useState(false);

  const languageOptions: Array<SheetOption<string>> = SUPPORTED_LOCALES.map((locale) => ({
    value: locale.code,
    label: locale.nativeLabel,
    description: locale.label,
  }));

  const currentLanguage = SUPPORTED_LOCALES.find((locale) => locale.code === i18n.language)?.nativeLabel ?? 'English';

  const setUnitsPreference = (value: 'metric' | 'imperial'): void => {
    setUnits(value);
    kv.set('app:units', value);
  };

  const clearCache = (): void => {
    // Only the cache namespace is dropped — the locale, units and onboarding
    // flags live under different keys and must survive.
    const cacheKeys = kv.allKeys().filter((key) => key.startsWith('cache:') || key.startsWith('draft:'));
    for (const key of cacheKeys) kv.delete(key);
    toast(t('cacheCleared'), 'success');
  };

  return (
    <Screen header={{ title: t('title'), large: true, back: true, onBack: () => router.back() }} testID="settings-screen">
      <SettingsGroup title={t('general')}>
        <Card flush>
          <PressableRow
            icon="language-outline"
            label={t('language')}
            value={currentLanguage}
            onPress={() => setShowLanguage(true)}
            testID="settings-language"
          />
          <PressableRow
            icon="notifications-outline"
            label={t('notifications')}
            onPress={() => router.push('/settings/notifications')}
            testID="settings-notifications"
          />
          <PressableRow
            icon="nutrition-outline"
            label="Diet & targets"
            onPress={() => router.push('/settings/preferences')}
            testID="settings-preferences"
          />
          <SwitchRow
            icon="phone-portrait-outline"
            label={t('haptics')}
            value={hapticsEnabled}
            onValueChange={setHaptics}
            testID="settings-haptics"
            last
          />
        </Card>
      </SettingsGroup>

      <SettingsGroup title="Measurement units">
        <Card flush>
          <View style={{ flexDirection: 'row', gap: spacing.sm, padding: spacing.lg }}>
            <Button
              label={t('metric')}
              variant={units === 'metric' ? 'primary' : 'outline'}
              size="sm"
              onPress={() => setUnitsPreference('metric')}
              style={{ flex: 1 }}
              testID="settings-units-metric"
            />
            <Button
              label={t('imperial')}
              variant={units === 'imperial' ? 'primary' : 'outline'}
              size="sm"
              onPress={() => setUnitsPreference('imperial')}
              style={{ flex: 1 }}
              testID="settings-units-imperial"
            />
          </View>
        </Card>
      </SettingsGroup>

      <SettingsGroup title={t('data')}>
        <Card flush>
          <PressableRow icon="trash-outline" label={t('cache')} value={isPersistent ? 'MMKV' : 'in memory'} onPress={clearCache} testID="settings-clear-cache" />
          <PressableRow icon="information-circle-outline" label={t('about')} onPress={() => router.push('/settings/about')} last testID="settings-about" />
        </Card>
      </SettingsGroup>

      {config.isDev ? (
        <SettingsGroup title={t('developer')}>
          <Card flush>
            <InfoRow icon="server-outline" label="API" value={config.apiBaseUrl} />
            <InfoRow icon="hardware-chip-outline" label="Environment" value={config.environment} />
            <InfoRow icon="cube-outline" label="Storage" value={isPersistent ? 'persistent' : 'volatile (web/test)'} />
            <PressableRow icon="refresh-outline" label={t('resetOnboarding')} onPress={() => { kv.delete(StorageKeys.onboardingSeen); toast('Onboarding will replay on next launch', 'success'); }} last />
          </Card>
        </SettingsGroup>
      ) : null}

      <Text variant="captionSmall" tone="tertiary" align="center">
        {t('version', { version: Constants.expoConfig?.version ?? config.environment })}
      </Text>

      <OptionSheet
        visible={showLanguage}
        onClose={() => setShowLanguage(false)}
        onSelect={(value) => void changeLocale(value as (typeof SUPPORTED_LOCALES)[number]['code'])}
        options={languageOptions}
        selected={i18n.language}
        title={t('language')}
      />
    </Screen>
  );
}

/** Tappable row with an icon, label and optional trailing value. */
export function PressableRow({
  icon,
  label,
  value,
  onPress,
  last = false,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress: () => void;
  last?: boolean;
  testID?: string;
}): React.ReactElement {
  return (
    <View testID={testID}>
      <Button
        label=""
        variant="ghost"
        onPress={onPress}
        accessibilityLabel={value ? `${label}, ${value}` : label}
        style={{ height: 56, borderRadius: 0, paddingHorizontal: spacing.lg, justifyContent: 'flex-start' }}
      />
      <View pointerEvents="none" style={{ position: 'absolute', left: spacing.lg, right: spacing.lg, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Ionicons name={icon} size={sizes.iconMd} color={colors.textSecondary} />
        <Text variant="bodyMedium" style={{ flex: 1 }} numberOfLines={1}>
          {label}
        </Text>
        {value ? (
          <Text variant="captionSmall" tone="tertiary" numberOfLines={1} style={{ maxWidth: 160 }}>
            {value}
          </Text>
        ) : null}
        <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
      </View>
      {last ? null : <View style={{ height: sizes.dividerHeight, backgroundColor: colors.divider, marginLeft: 56 }} />}
    </View>
  );
}

/** Non-interactive row used for read-only developer info. */
function InfoRow({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.lg }}>
      <Ionicons name={icon} size={sizes.iconMd} color={colors.textSecondary} />
      <Text variant="bodyMedium" style={{ flex: 1 }} numberOfLines={1}>
        {label}
      </Text>
      <Text variant="captionSmall" tone="tertiary" numberOfLines={1} style={{ maxWidth: 180 }}>
        {value}
      </Text>
    </View>
  );
}
