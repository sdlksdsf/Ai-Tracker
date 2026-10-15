import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button, IconButton } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Sheet } from '../../components/ui/Sheet.js';
import { Input } from '../../components/ui/Input.js';
import { StatCard, StatGrid } from '../../components/StatCard.js';
import { ProgressBar } from '../../components/ui/Progress.js';
import { useAuthStore } from '../../stores/auth.store.js';
import { toast, clearToastTimers } from '../../stores/ui.store.js';
import { queryClient } from '../../lib/query.js';
import { api } from '../../lib/api.js';
import { kv } from '../../lib/kv.js';
import {
  useAchievementsProgress,
  usePantryStats,
  useSavings,
  useSubscriptionStatus,
  useUnreadCount,
} from '../../hooks/useApi.js';
import { formatDate, formatMoney, humanize } from '../../lib/format.js';

/**
 * Profile (Section 6, Screen 13).
 *
 * The user's impact numbers come first — this screen is where someone checks
 * whether the app is working for them — followed by settings, plan and account
 * actions. Sign-out and account deletion are both confirmed, and deletion is
 * behind a typed confirmation because it is irreversible.
 */

export default function ProfileScreen(): React.ReactElement {
  const { t } = useTranslation('profile');
  const router = useRouter();

  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);

  const { data: savings } = useSavings('month');
  const { data: pantryStats } = usePantryStats();
  const { data: achievements } = useAchievementsProgress();
  const { data: subscription } = useSubscriptionStatus();
  const { data: unread } = useUnreadCount();

  const [showSignOut, setShowSignOut] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const tier = user?.subscription_tier ?? 'free';
  const isPremium = tier !== 'free';

  const handleSignOut = async (): Promise<void> => {
    setShowSignOut(false);
    clearToastTimers();
    // Drop every cached query so the next account cannot see this one's data.
    queryClient.clear();
    kv.clear();
    await signOut(false);
    router.replace('/(auth)/login');
  };

  const handleDelete = async (): Promise<void> => {
    if (deleteText.trim().toUpperCase() !== 'DELETE') {
      toast('Type DELETE to confirm', 'warning');
      return;
    }

    setDeleting(true);
    try {
      await api.delete('/users/me');
      queryClient.clear();
      kv.clear();
      await signOut(true);
      router.replace('/(auth)/login');
    } catch (err) {
      toast((err as Error).message, 'error');
      setDeleting(false);
    }
  };

  return (
    <Screen
      header={{ title: t('title'), large: true }}
      padding={false}
      testID="profile-screen"
      contentStyle={{ paddingBottom: spacing.huge * 2 }}
    >
      {/* --- Identity -------------------------------------------------------- */}
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg }}>
        <Card padding="xl" style={{ gap: spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
            <View
              style={{
                width: sizes.avatarLg,
                height: sizes.avatarLg,
                borderRadius: radii.pill,
                backgroundColor: colors.primarySoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="displaySmall" tone="primary">
                {(user?.full_name ?? 'U').charAt(0).toUpperCase()}
              </Text>
            </View>

            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="headingMedium" numberOfLines={1}>
                {user?.full_name ?? 'PlateMatch user'}
              </Text>
              <Text variant="bodySmall" tone="secondary" numberOfLines={1}>
                {user?.email}
              </Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, flexWrap: 'wrap' }}>
                <Badge label={isPremium ? humanize(tier) : t('freePlan')} tone={isPremium ? 'secondary' : 'neutral'} icon={isPremium ? 'sparkles' : undefined} />
                {user?.dietary_preference && user.dietary_preference !== 'none' ? (
                  <Badge label={humanize(user.dietary_preference)} tone="accent" />
                ) : null}
              </View>
            </View>

            <IconButton icon="create-outline" onPress={() => router.push('/settings/preferences')} accessibilityLabel={t('editProfile')} testID="profile-edit" />
          </View>

          {user?.created_at ? (
            <Text variant="captionSmall" tone="tertiary">
              {t('memberSince', { date: formatDate(user.created_at.slice(0, 10)) })}
            </Text>
          ) : null}

          {subscription?.usage ? (
            <View style={{ gap: spacing.xs }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="captionSmall" tone="tertiary">
                  Scans this week
                </Text>
                <Text variant="captionSmall" tone="tertiary">
                  {subscription.usage.scans_used_this_week}
                  {subscription.usage.scans_remaining != null ? `/${subscription.usage.scans_remaining + subscription.usage.scans_used_this_week}` : ''}
                </Text>
              </View>
              <ProgressBar
                value={
                  subscription.usage.scans_remaining != null && subscription.usage.scans_remaining + subscription.usage.scans_used_this_week > 0
                    ? subscription.usage.scans_used_this_week / (subscription.usage.scans_remaining + subscription.usage.scans_used_this_week)
                    : 0
                }
                height={sizes.progressHeightSm}
              />
            </View>
          ) : null}
        </Card>

        {/* --- Impact -------------------------------------------------------- */}
        <View style={{ gap: spacing.md }}>
          <Text variant="headingSmall">{t('statsTitle')}</Text>
          <StatGrid>
            <StatCard label="Saved this month" value={formatMoney(savings?.total_saved_usd ?? 0)} icon="wallet-outline" tone={colors.success} softTone={colors.successSoft} onPress={() => router.push('/waste')} compact testID="profile-savings" />
            <StatCard label="Pantry items" value={String(pantryStats?.total_items ?? 0)} icon="file-tray-full-outline" onPress={() => router.push('/pantry')} compact />
            <StatCard label="Badges" value={`${achievements?.earned ?? 0}/${achievements?.total ?? 0}`} icon="ribbon-outline" tone={colors.warning} softTone={colors.warningSoft} onPress={() => router.push('/achievements')} compact />
            <StatCard label="Level" value={String(achievements?.level ?? 1)} icon="trending-up-outline" tone={colors.accent} softTone={colors.accentSoft} sublabel={achievements?.level_label} onPress={() => router.push('/achievements')} compact />
          </StatGrid>
        </View>

        {/* --- Subscription -------------------------------------------------- */}
        <Card padding="lg" onPress={() => router.push('/premium')} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }} testID="profile-subscription">
          <View style={{ width: 40, height: 40, borderRadius: radii.sm, backgroundColor: isPremium ? colors.secondarySoft : colors.divider, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={isPremium ? 'sparkles' : 'lock-closed-outline'} size={sizes.iconMd} color={isPremium ? colors.secondaryDark : colors.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium">{t('subscription')}</Text>
            <Text variant="captionSmall" tone="tertiary">
              {isPremium
                ? subscription?.expires_at
                  ? `Renews ${formatDate(subscription.expires_at.slice(0, 10))}`
                  : humanize(tier)
                : 'Unlock unlimited scans and price comparison'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
        </Card>

        {/* --- Settings rows ------------------------------------------------- */}
        <Card flush testID="profile-settings">
          <SettingsRow icon="person-outline" label={t('preferences')} onPress={() => router.push('/settings/preferences')} />
          <SettingsRow
            icon="notifications-outline"
            label={t('notifications')}
            onPress={() => router.push('/settings/notifications')}
            badge={unread?.unread ? String(unread.unread) : undefined}
          />
          <SettingsRow icon="trophy-outline" label="Achievements" onPress={() => router.push('/achievements')} />
          <SettingsRow icon="leaf-outline" label="Food waste & impact" onPress={() => router.push('/waste')} />
          <SettingsRow icon="cart-outline" label="Grocery lists" onPress={() => router.push('/grocery/latest')} />
          <SettingsRow icon="settings-outline" label={t('settings')} onPress={() => router.push('/settings')} last />
        </Card>

        {/* --- Support ------------------------------------------------------- */}
        <Card flush>
          <SettingsRow icon="help-circle-outline" label={t('helpSupport')} onPress={() => router.push('/settings/about')} />
          <SettingsRow icon="star-outline" label={t('rateApp')} onPress={() => toast('Thanks for considering it!', 'success')} />
          <SettingsRow icon="document-text-outline" label={t('privacy')} onPress={() => router.push('/settings/about')} />
          <SettingsRow icon="shield-checkmark-outline" label={t('terms')} onPress={() => router.push('/settings/about')} last />
        </Card>

        {/* --- Allergens summary --------------------------------------------- */}
        {user?.allergies?.length ? (
          <Card padding="lg" style={{ gap: spacing.sm }} testID="profile-allergies">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="shield-checkmark-outline" size={sizes.iconSm} color={colors.danger} />
              <Text variant="headingSmall">{t('allergies')}</Text>
            </View>
            <Text variant="captionSmall" tone="secondary">
              Every recipe and meal plan is re-checked against these before it reaches you. Anything containing one is rejected whole.
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {user.allergies.map((allergy) => (
                <Badge key={allergy.id} label={`${humanize(allergy.allergen)} · ${allergy.severity}`} tone="danger" size="sm" />
              ))}
            </View>
          </Card>
        ) : null}

        {/* --- Account actions ----------------------------------------------- */}
        <View style={{ gap: spacing.md }}>
          <Button label={t('signOut')} icon="log-out-outline" variant="outline" onPress={() => setShowSignOut(true)} block testID="profile-signout" />
          <Button label={t('deleteAccount')} icon="trash-outline" variant="ghost" onPress={() => { setDeleteText(''); setShowDelete(true); }} block testID="profile-delete" />
        </View>
      </View>

      {/* --- Confirm sign-out ------------------------------------------------ */}
      <Sheet visible={showSignOut} onClose={() => setShowSignOut(false)} title={t('signOutConfirm')} scrollable={false} testID="profile-signout-sheet">
        <View style={{ gap: spacing.md }}>
          <Text variant="bodySmall" tone="secondary">
            Your pantry, plans and history stay saved on this account.
          </Text>
          <Button label={t('signOut')} icon="log-out-outline" variant="danger" onPress={() => void handleSignOut()} block />
          <Button label={t('common:cancel', { ns: 'common' })} variant="ghost" onPress={() => setShowSignOut(false)} block />
        </View>
      </Sheet>

      {/* --- Confirm deletion ------------------------------------------------ */}
      <Sheet visible={showDelete} onClose={() => setShowDelete(false)} title={t('deleteAccount')} scrollable={false} testID="profile-delete-sheet">
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.dangerSoft }}>
            <Ionicons name="warning" size={sizes.iconSm} color={colors.danger} />
            <Text variant="captionSmall" tone="danger" style={{ flex: 1 }}>
              {t('deleteAccountWarning')}
            </Text>
          </View>

          <Text variant="bodySmall" tone="secondary">
            Type <Text variant="bodyMedium">DELETE</Text> to confirm.
          </Text>

          <Input value={deleteText} onChangeText={setDeleteText} placeholder="DELETE" autoCapitalize="characters" autoCorrect={false} testID="profile-delete-input" />

          <Button label={t('deleteAccount')} icon="trash" variant="danger" onPress={() => void handleDelete()} loading={deleting} disabled={deleteText.trim().toUpperCase() !== 'DELETE'} block />
          <Button label={t('common:cancel', { ns: 'common' })} variant="ghost" onPress={() => setShowDelete(false)} block />
        </View>
      </Sheet>
    </Screen>
  );
}

function SettingsRow({
  icon,
  label,
  onPress,
  badge,
  last = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  badge?: string;
  last?: boolean;
}): React.ReactElement {
  return (
    <Card flush>
      <Button
        label=""
        onPress={onPress}
        variant="ghost"
        style={{ flexDirection: 'row', justifyContent: 'flex-start', height: 56, paddingHorizontal: spacing.lg, gap: spacing.md, borderRadius: 0 }}
        accessibilityLabel={label}
      />
      <View pointerEvents="none" style={{ position: 'absolute', left: spacing.lg, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md, right: spacing.lg, justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Ionicons name={icon} size={sizes.iconMd} color={colors.textSecondary} />
          <Text variant="bodyMedium">{label}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {badge ? <Badge label={badge} tone="danger" size="sm" /> : null}
          <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
        </View>
      </View>
      {last ? null : <View style={{ height: sizes.dividerHeight, backgroundColor: colors.divider, marginLeft: 56 }} />}
    </Card>
  );
}
