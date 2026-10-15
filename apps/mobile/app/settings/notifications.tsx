import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { Sheet, OptionSheet, type SheetOption } from '../../components/ui/Sheet.js';
import { SwitchRow, SettingsGroup, TimeRow } from './_components.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { toast } from '../../stores/ui.store.js';
import { useNotificationPreferences, useUpdateNotificationPreferences } from '../../hooks/useApi.js';
import { api } from '../../lib/api.js';
import { kv, StorageKeys } from '../../lib/kv.js';
import { createLogger } from '../../lib/logger.js';

/**
 * Notification settings (Section 7).
 *
 * The six triggers the product promises are all individually switchable, with
 * their delivery time shown next to each so the user can predict when a
 * notification will arrive. Quiet hours are honoured server-side by every
 * scheduled sweep, which is stated here rather than left implicit.
 */

const log = createLogger('NotificationSettings');

const HOURS: string[] = Array.from({ length: 24 }, (_, index) => `${String(index).padStart(2, '0')}:00`);

export default function NotificationSettingsScreen(): React.ReactElement {
  const { t } = useTranslation('settings');
  const router = useRouter();

  const { data: prefs, isLoading } = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();

  const [systemPermission, setSystemPermission] = useState<boolean | null>(null);
  const [expiryAlerts, setExpiryAlerts] = useState(true);
  const [mealReminders, setMealReminders] = useState(true);
  const [weeklyReports, setWeeklyReports] = useState(true);
  const [smartSuggestions, setSmartSuggestions] = useState(true);
  const [achievementAlerts, setAchievementAlerts] = useState(true);
  const [breakfast, setBreakfast] = useState('07:30');
  const [lunch, setLunch] = useState('12:00');
  const [dinner, setDinner] = useState('18:30');
  const [quietStart, setQuietStart] = useState<string | null>(null);
  const [quietEnd, setQuietEnd] = useState<string | null>(null);

  const [timeTarget, setTimeTarget] = useState<'breakfast' | 'lunch' | 'dinner' | 'quietStart' | 'quietEnd' | null>(null);

  // Hydrate the form from the server once, so local edits are not clobbered by a
  // background refetch while the user is mid-change.
  useEffect(() => {
    if (!prefs) return;
    const values = prefs as Record<string, unknown>;
    setExpiryAlerts(Boolean(values.expiry_alerts ?? true));
    setMealReminders(Boolean(values.meal_reminders ?? true));
    setWeeklyReports(Boolean(values.weekly_reports ?? true));
    setSmartSuggestions(Boolean(values.smart_suggestions ?? true));
    setAchievementAlerts(Boolean(values.achievement_alerts ?? true));
    setBreakfast(String(values.reminder_breakfast_time ?? '07:30'));
    setLunch(String(values.reminder_lunch_time ?? '12:00'));
    setDinner(String(values.reminder_dinner_time ?? '18:30'));
    setQuietStart((values.quiet_hours_start as string | null) ?? null);
    setQuietEnd((values.quiet_hours_end as string | null) ?? null);
  }, [prefs]);

  // Ask the OS separately from the in-app toggles: a user can have every trigger
  // on and still receive nothing if the system permission is off.
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const current = await Notifications.getPermissionsAsync();
        setSystemPermission(current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL);
      } catch (err) {
        log.warn('Could not read notification permission', err);
        setSystemPermission(false);
      }
    };
    void check();
  }, []);

  const requestPermission = async (): Promise<void> => {
    try {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('platematch-default', {
          name: 'PlateMatch',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: colors.primary,
        });
      }

      const result = await Notifications.requestPermissionsAsync();
      const granted = result.granted || result.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
      setSystemPermission(granted);

      if (!granted) {
        toast('Notifications are blocked in your system settings', 'warning', { durationMs: 6000 });
        return;
      }

      // Register the Expo push token so the server has somewhere to deliver.
      const token = await Notifications.getExpoPushTokenAsync();
      if (token?.data) {
        await api.post('/notifications/device', {
          fcm_token: token.data,
          platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
          // `brand` only exists on the Android shape of the constants union.
          device_name: (Platform.constants as { brand?: string } | undefined)?.brand,
        });
        kv.set(StorageKeys.pushToken, token.data);
        toast('Notifications enabled', 'success');
      }
    } catch (err) {
      log.error('Failed to enable notifications', err);
      toast('Could not enable notifications', 'error');
    }
  };

  const save = async (): Promise<void> => {
    await update.mutateAsync({
      expiry_alerts: expiryAlerts,
      meal_reminders: mealReminders,
      weekly_reports: weeklyReports,
      smart_suggestions: smartSuggestions,
      achievement_alerts: achievementAlerts,
      reminder_breakfast_time: breakfast,
      reminder_lunch_time: lunch,
      reminder_dinner_time: dinner,
      quiet_hours_start: quietStart,
      quiet_hours_end: quietEnd,
    });
  };

  // Leaving the screen saves, so a toggle is never silently lost.
  useEffect(() => () => void (prefs ? save() : Promise.resolve()), [prefs]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeOptions: Array<SheetOption<string>> = [
    { value: '', label: 'Off' },
    ...HOURS.map((hour) => ({ value: hour, label: hour })),
    { value: '22:30', label: '22:30' },
    { value: '23:30', label: '23:30' },
  ];

  if (isLoading) {
    return (
      <Screen header={{ title: t('notifications'), back: true, onBack: () => router.back() }} testID="notification-settings-screen">
        <SkeletonList count={5} />
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: t('notifications'), back: true, onBack: () => router.back() }}
      testID="notification-settings-screen"
      footer={<Button label={t('common:save', { ns: 'common' })} icon="checkmark" onPress={() => void save()} loading={update.isPending} block size="lg" testID="notifications-save" />}
    >
      {systemPermission === false ? (
        <Card padding="lg" style={{ gap: spacing.sm, backgroundColor: colors.warningSoft }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Ionicons name="notifications-off-outline" size={sizes.iconMd} color={colors.warning} />
            <Text variant="bodyMedium">System notifications are off</Text>
          </View>
          <Text variant="captionSmall" tone="secondary">
            These settings only control what PlateMatch sends. Your device also has to allow them.
          </Text>
          <Button label="Allow notifications" icon="notifications-outline" size="sm" onPress={() => void requestPermission()} />
        </Card>
      ) : null}

      <SettingsGroup title="Alerts">
        <Card flush>
          <SwitchRow
            icon="alert-circle-outline"
            label={t('expiryAlerts')}
            hint={`${t('expiryAlertsHint')} Delivered at 9 AM your time.`}
            value={expiryAlerts}
            onValueChange={setExpiryAlerts}
            testID="notifications-expiry"
          />
          <SwitchRow
            icon="restaurant-outline"
            label={t('mealReminders')}
            hint="Uses the three times below."
            value={mealReminders}
            onValueChange={setMealReminders}
            testID="notifications-meals"
          />
          <SwitchRow
            icon="calendar-outline"
            label={t('weeklyReports')}
            hint={t('weeklyReportsHint')}
            value={weeklyReports}
            onValueChange={setWeeklyReports}
            testID="notifications-weekly"
          />
          <SwitchRow
            icon="bulb-outline"
            label={t('smartSuggestions')}
            hint={'A "cook this before it expires" recipe at 5 PM.'}
            value={smartSuggestions}
            onValueChange={setSmartSuggestions}
            testID="notifications-suggestions"
          />
          <SwitchRow
            icon="trophy-outline"
            label={t('achievementAlerts')}
            hint="Sent the moment a badge unlocks."
            value={achievementAlerts}
            onValueChange={setAchievementAlerts}
            last
            testID="notifications-achievements"
          />
        </Card>
      </SettingsGroup>

      <SettingsGroup title={t('reminderTimes')}>
        <Card flush>
          <TimeRow icon="cafe-outline" label={t('breakfast')} value={breakfast} onPress={() => setTimeTarget('breakfast')} testID="notifications-breakfast" />
          <TimeRow icon="sunny-outline" label={t('lunch')} value={lunch} onPress={() => setTimeTarget('lunch')} testID="notifications-lunch" />
          <TimeRow icon="moon-outline" label={t('dinner')} value={dinner} onPress={() => setTimeTarget('dinner')} last testID="notifications-dinner" />
        </Card>
      </SettingsGroup>

      <SettingsGroup title={t('quietHours')}>
        <Card flush>
          <TimeRow icon="moon-outline" label="From" value={quietStart ?? 'Off'} onPress={() => setTimeTarget('quietStart')} testID="notifications-quiet-start" />
          <TimeRow icon="sunny-outline" label="Until" value={quietEnd ?? 'Off'} onPress={() => setTimeTarget('quietEnd')} last testID="notifications-quiet-end" />
        </Card>
        <Text variant="captionSmall" tone="tertiary" style={{ paddingHorizontal: spacing.xs }}>
          {t('quietHoursHint')} Expiry alerts, meal reminders and the weekly digest all respect this window.
        </Text>
      </SettingsGroup>

      <Card padding="lg" style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Ionicons name="information-circle-outline" size={sizes.iconSm} color={colors.textTertiary} />
          <Text variant="caption" tone="secondary">
            How delivery works
          </Text>
        </View>
        <Text variant="captionSmall" tone="tertiary">
          Every notification is written to your in-app inbox first, then pushed to your devices. If a push fails or your token goes stale, the notification is still waiting in the bell — nothing is lost.
        </Text>
      </Card>

      <OptionSheet
        visible={timeTarget !== null}
        onClose={() => setTimeTarget(null)}
        onSelect={(value) => {
          if (timeTarget === 'breakfast') setBreakfast(value || '07:30');
          else if (timeTarget === 'lunch') setLunch(value || '12:00');
          else if (timeTarget === 'dinner') setDinner(value || '18:30');
          else if (timeTarget === 'quietStart') setQuietStart(value || null);
          else if (timeTarget === 'quietEnd') setQuietEnd(value || null);
          setTimeTarget(null);
        }}
        options={timeOptions}
        selected={
          timeTarget === 'breakfast' ? breakfast : timeTarget === 'lunch' ? lunch : timeTarget === 'dinner' ? dinner : timeTarget === 'quietStart' ? quietStart ?? '' : quietEnd ?? ''
        }
        title={
          timeTarget === 'quietStart' || timeTarget === 'quietEnd' ? 'Quiet hours' : t('reminderTimes')
        }
      />

      <View style={{ borderRadius: radii.sm }} />
    </Screen>
  );
}
