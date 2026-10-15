import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { PLAN_LIMITS, type SubscriptionTier } from '@platematch/shared';
import { colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Screen } from '../components/ui/Screen.js';
import { Text } from '../components/ui/Text.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Badge } from '../components/ui/Badge.js';
import { Chip } from '../components/ui/Chip.js';
import { toast } from '../stores/ui.store.js';
import { useAuthStore } from '../stores/auth.store.js';
import { usePlans, useStartCheckout, useSubscriptionStatus } from '../hooks/useApi.js';
import { formatMoney } from '../lib/format.js';

/**
 * Premium (Section 6, Screen 14 + Section 9 — Monetization).
 *
 * The pitch is the user's own numbers: what they hit this week, what the limit is,
 * and what the price comparison would have saved. Generic feature lists do not
 * convert; a quota the user actually ran into does.
 *
 * When Stripe is not configured the API returns `simulated: true` and we say so
 * plainly instead of pretending a payment happened.
 */

type Interval = 'monthly' | 'yearly';

const PRICING: Record<Exclude<SubscriptionTier, 'free'>, Record<Interval, number>> = {
  premium: { monthly: 4.99, yearly: 39.99 },
  family: { monthly: 7.99, yearly: 59.99 },
};

const FEATURES: Array<{ icon: keyof typeof Ionicons.glyphMap; title: string; body: string }> = [
  { icon: 'camera-outline', title: 'Unlimited fridge scans', body: 'Free gives you 3 a week. Scan as often as you shop.' },
  { icon: 'sparkles-outline', title: 'Unlimited AI recipes', body: 'No daily cap on generation, and no monthly cap on meal plans.' },
  { icon: 'pricetags-outline', title: 'Multi-store price comparison', body: 'Every line priced at Kroger and Spoonacular, routed to the cheapest store.' },
  { icon: 'stats-chart-outline', title: 'Advanced savings analytics', body: 'Year-over-year waste trends and the full CO₂ breakdown.' },
  { icon: 'volume-high-outline', title: 'Hands-free voice cooking', body: 'Steps read aloud while your hands are covered in flour.' },
  { icon: 'share-outline', title: 'Export and share lists', body: 'PDF and share-sheet export for grocery lists and meal plans.' },
  // PLAN_LIMITS.free.ads is true — the free tier is ad-supported, so this must
  // say ads are *removed* rather than claiming none exist anywhere.
  { icon: 'remove-circle-outline', title: 'No ads', body: 'The free plan is ad-supported. Premium and Family remove them entirely.' },
];

export default function PremiumScreen(): React.ReactElement {
  const { t } = useTranslation('premium');
  const router = useRouter();

  const tier = useAuthStore((state) => state.user?.subscription_tier ?? 'free');
  const { data: status } = useSubscriptionStatus();
  const { data: catalog } = usePlans();
  const checkout = useStartCheckout();

  const [selectedTier, setSelectedTier] = useState<Exclude<SubscriptionTier, 'free'>>('premium');
  const [interval, setInterval] = useState<Interval>('monthly');

  const price = PRICING[selectedTier][interval];
  const monthlyEquivalent = interval === 'yearly' ? price / 12 : price;
  const yearlySaving = interval === 'yearly' ? Math.round((1 - price / (PRICING[selectedTier].monthly * 12)) * 100) : 0;

  const usage = status?.usage;
  const limits = PLAN_LIMITS[tier as SubscriptionTier] ?? PLAN_LIMITS.free;

  const handleSubscribe = async (): Promise<void> => {
    try {
      const result = await checkout.mutateAsync({ tier: selectedTier, interval });

      if (result.simulated) {
        // Payments are not configured on this server. Say so, and refresh so the
        // UI reflects the tier the API just granted.
        toast(t('simulatedNotice'), 'warning', { durationMs: 8000 });
        await useAuthStore.getState().fetchMe().then((user) => {
          if (user) useAuthStore.getState().setUser(user);
        });
        router.back();
        return;
      }

      if (result.checkout_url) {
        await Linking.openURL(result.checkout_url);
        toast('Complete payment in your browser, then pull to refresh here.', 'info', { durationMs: 8000 });
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <Screen
      header={{ title: '', back: true, onBack: () => router.back() }}
      padding={false}
      testID="premium-screen"
      footer={
        tier === 'free' ? (
          <View style={{ gap: spacing.xs }}>
            <Button
              label={`${t('subscribe', { tier: selectedTier === 'premium' ? 'Premium' : 'Family' })} · ${formatMoney(price)}`}
              icon="sparkles"
              onPress={() => void handleSubscribe()}
              loading={checkout.isPending}
              block
              size="lg"
              testID="premium-subscribe"
            />
            <Text variant="captionSmall" tone="tertiary" align="center">
              {t('cancelAnytime')} · {formatMoney(monthlyEquivalent)}/month effective
            </Text>
          </View>
        ) : (
          <Button label={t('manage')} icon="settings-outline" variant="outline" onPress={() => toast('Opens the Stripe billing portal', 'info')} block />
        )
      }
    >
      {/* --- Hero ------------------------------------------------------------ */}
      <View style={{ backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingTop: spacing.xxl, paddingBottom: spacing.xxxl, gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Ionicons name="sparkles" size={sizes.iconLg} color={colors.textInverse} />
          <Badge label={tier === 'free' ? 'Upgrade' : 'Your plan'} tone="secondary" solid />
        </View>

        <Text variant="displayMedium" style={{ color: colors.textInverse }}>
          {t('title')}
        </Text>
        <Text variant="bodyLarge" style={{ color: 'rgba(255,255,255,0.88)' }}>
          {t('subtitle')}
        </Text>
      </View>

      <View style={{ paddingHorizontal: spacing.lg, marginTop: -spacing.xl, gap: spacing.lg }}>
        {/* --- Your usage this week ---------------------------------------- */}
        {usage ? (
          <Card padding="lg" style={{ gap: spacing.md }} elevated="level2" testID="premium-usage">
            <Text variant="headingSmall">Where you are this week</Text>

            <UsageRow
              label="Fridge scans"
              used={usage.scans_used_this_week}
              remaining={usage.scans_remaining}
              limit={limits.scansPerWeek}
            />
            <UsageRow
              label="AI recipes today"
              used={usage.recipes_generated_today}
              remaining={usage.recipes_remaining_today}
              limit={limits.recipeGenerationsPerDay}
            />
            <UsageRow
              label="Meal plans this month"
              used={usage.meal_plans_this_month}
              remaining={usage.meal_plans_remaining}
              limit={limits.mealPlansPerMonth}
            />
            <UsageRow
              label="Pantry items"
              used={usage.pantry_items}
              remaining={usage.pantry_items_max != null ? Math.max(0, usage.pantry_items_max - usage.pantry_items) : null}
              limit={usage.pantry_items_max ?? limits.maxPantryItems}
            />

            <Text variant="captionSmall" tone="tertiary">
              On {tier === 'free' ? 'Free' : 'your plan'} these are hard limits. Premium and Family remove all four.
            </Text>
          </Card>
        ) : null}

        {/* --- Plan picker -------------------------------------------------- */}
        {tier === 'free' ? (
          <Card padding="lg" style={{ gap: spacing.lg }}>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {(['monthly', 'yearly'] as const).map((option) => (
                <Chip
                  key={option}
                  label={option === 'monthly' ? t('monthly') : `${t('yearly')} · ${t('savePercent', { percent: Math.round((1 - PRICING[selectedTier].yearly / (PRICING[selectedTier].monthly * 12)) * 100) })}`}
                  selected={interval === option}
                  onPress={() => setInterval(option)}
                  testID={`premium-interval-${option}`}
                />
              ))}
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              {(['premium', 'family'] as const).map((option) => {
                const selected = selectedTier === option;
                const planPrice = PRICING[option][interval];
                return (
                  <Card
                    key={option}
                    outlined
                    padding="lg"
                    onPress={() => setSelectedTier(option)}
                    selected={selected}
                    style={{ flex: 1, gap: spacing.xs }}
                    testID={`premium-tier-${option}`}
                  >
                    <Text variant="headingSmall">{option === 'premium' ? 'Premium' : 'Family'}</Text>
                    <Text variant="statSmall">{formatMoney(planPrice)}</Text>
                    <Text variant="captionSmall" tone="tertiary">
                      {interval === 'monthly' ? t('perMonth') : t('perYear')}
                    </Text>
                    {option === 'family' ? (
                      <Text variant="captionSmall" tone="secondary">
                        Shared household for {PLAN_LIMITS.family.sharedHouseholdMembers}
                      </Text>
                    ) : null}
                    {selected ? <Badge label="Selected" tone="primary" size="sm" /> : null}
                  </Card>
                );
              })}
            </View>

            {interval === 'yearly' && yearlySaving > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.successSoft }}>
                <Ionicons name="trending-down" size={sizes.iconSm} color={colors.success} />
                <Text variant="caption" tone="success" style={{ flex: 1 }}>
                  You save {yearlySaving}% — about {formatMoney(PRICING[selectedTier].monthly * 12 - price)} a year.
                </Text>
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* --- Feature list ------------------------------------------------- */}
        <View style={{ gap: spacing.md }}>
          <Text variant="headingSmall">{t('featuresTitle')}</Text>

          {FEATURES.map((feature) => (
            <View key={feature.title} style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
              <View style={{ width: 40, height: 40, borderRadius: radii.sm, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={feature.icon} size={sizes.iconMd} color={colors.primary} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyMedium">{feature.title}</Text>
                <Text variant="captionSmall" tone="secondary">
                  {feature.body}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* --- Comparison table --------------------------------------------- */}
        {catalog ? (
          <Card padding="lg" style={{ gap: spacing.md }}>
            <Text variant="headingSmall">Plan comparison</Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Text variant="caption" tone="tertiary" style={{ flex: 2 }}>
                Feature
              </Text>
              <Text variant="caption" tone="tertiary" style={{ flex: 1, textAlign: 'center' }}>
                Free
              </Text>
              <Text variant="caption" tone="tertiary" style={{ flex: 1, textAlign: 'center' }}>
                Premium
              </Text>
              <Text variant="caption" tone="tertiary" style={{ flex: 1, textAlign: 'center' }}>
                Family
              </Text>
            </View>

            {COMPARISON_ROWS.map((row) => (
              <View key={row.label} style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center', paddingVertical: spacing.xs, borderTopWidth: sizes.dividerHeight, borderTopColor: colors.divider }}>
                <Text variant="captionSmall" tone="secondary" style={{ flex: 2 }}>
                  {row.label}
                </Text>
                <ComparisonCell value={row.free} />
                <ComparisonCell value={row.premium} />
                <ComparisonCell value={row.family} />
              </View>
            ))}
          </Card>
        ) : null}

        <Text variant="captionSmall" tone="tertiary" align="center" style={{ paddingBottom: spacing.lg }}>
          {t('cancelAnytime')} Payments are handled by Stripe; PlateMatch never stores your card.
        </Text>
      </View>
    </Screen>
  );
}

// Cells are a label, a checkmark, or a raw number (`Household members: 0`).
const COMPARISON_ROWS: Array<{
  label: string;
  free: string | boolean | number;
  premium: string | boolean | number;
  family: string | boolean | number;
}> = [
  { label: 'Fridge scans', free: `${PLAN_LIMITS.free.scansPerWeek}/week`, premium: 'Unlimited', family: 'Unlimited' },
  { label: 'AI recipes', free: `${PLAN_LIMITS.free.recipeGenerationsPerDay}/day`, premium: 'Unlimited', family: 'Unlimited' },
  { label: 'Meal plans', free: `${PLAN_LIMITS.free.mealPlansPerMonth}/month`, premium: 'Unlimited', family: 'Unlimited' },
  { label: 'Pantry items', free: PLAN_LIMITS.free.maxPantryItems, premium: 'Unlimited', family: 'Unlimited' },
  { label: 'Price comparison', free: PLAN_LIMITS.free.priceComparison, premium: true, family: true },
  { label: 'Advanced analytics', free: PLAN_LIMITS.free.advancedAnalytics, premium: true, family: true },
  { label: 'Voice cooking', free: PLAN_LIMITS.free.cookingModeVoice, premium: true, family: true },
  { label: 'Household members', free: 0, premium: 0, family: PLAN_LIMITS.family.sharedHouseholdMembers },
];

function ComparisonCell({ value }: { value: string | boolean | number }): React.ReactElement {
  if (value === true) return <Ionicons name="checkmark-circle" size={sizes.iconSm} color={colors.success} style={{ flex: 1, textAlign: 'center' }} />;
  if (value === false || value === 0) return <Ionicons name="close-circle" size={sizes.iconSm} color={colors.borderStrong} style={{ flex: 1, textAlign: 'center' }} />;
  return (
    <Text variant="captionSmall" tone="secondary" align="center" style={{ flex: 1 }}>
      {String(value)}
    </Text>
  );
}

function UsageRow({ label, used, remaining, limit }: { label: string; used: number; remaining: number | null; limit: number | null }): React.ReactElement {
  // `remaining === null` and `limit === null` both mean unlimited.
  const unlimited = remaining === null || limit === null;
  const ratio = unlimited || limit === 0 ? 0 : Math.min(1, used / limit);
  const nearlyOut = !unlimited && ratio >= 0.8;

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
        <Text variant="caption" tone={nearlyOut ? 'danger' : 'default'}>
          {unlimited ? `${used} used · unlimited` : `${used}/${limit}${remaining != null ? ` · ${remaining} left` : ''}`}
        </Text>
      </View>
      {!unlimited ? (
        <View style={{ height: 6, borderRadius: radii.pill, backgroundColor: colors.divider, overflow: 'hidden' }}>
          <View style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: nearlyOut ? colors.danger : colors.primary }} />
        </View>
      ) : null}
    </View>
  );
}
