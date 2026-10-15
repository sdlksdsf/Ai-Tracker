import React, { useMemo } from 'react';
import { View, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import type { RecipeDto } from '@platematch/shared';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen, SectionHeader } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { StatCard, StatGrid } from '../../components/StatCard.js';
import { ProgressBar } from '../../components/ui/Progress.js';
import { ExpiringCarousel } from '../../components/ExpiringCarousel.js';
import { RecipeCard } from '../../components/RecipeCard.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState.js';
import { useHomeSummary } from '../../hooks/useApi.js';
import { formatCo2, formatMoney, formatShortDate, pluralize } from '../../lib/format.js';

/**
 * Home (Section 6, Screen 2).
 *
 * Answers three questions in one scroll, in the order the user has them:
 *   1. What is about to go off, and what can I cook with it?
 *   2. What is the plan for today?
 *   3. Am I making progress — money, CO₂, streak?
 *
 * Everything renders from a single `/dashboard/home` request, so a cold start is
 * one round trip rather than seven. The greeting comes from the server, which
 * knows the user's timezone; computing it on the device would be wrong for
 * anyone travelling.
 */

export default function HomeScreen(): React.ReactElement {
  const { t } = useTranslation('home');
  const router = useRouter();
  const client = useQueryClient();

  const { data: home, isLoading, isError, error, refetch, isRefetching } = useHomeSummary();

  const suggestions: RecipeDto[] = useMemo(() => home?.quick_recipes ?? [], [home?.quick_recipes]);

  if (isError && !home) {
    return (
      <Screen testID="home-screen">
        <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const pantry = home?.pantry_summary;
  const snapshot = home?.stats_snapshot;
  const expiring = home?.expiring_soon ?? [];
  const todaysMeals = home?.todays_meals ?? [];
  const pantryProgress = pantry && pantry.total_items > 0 ? pantry.expiring_soon_count / pantry.total_items : 0;

  return (
    <Screen
      scrollable
      padding={false}
      testID="home-screen"
      scrollProps={{
        refreshControl: (
          <RefreshControl
            refreshing={isRefetching && !isLoading}
            onRefresh={() => {
              void client.invalidateQueries({ queryKey: ['home'] });
              void refetch();
            }}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        ),
      }}
      contentStyle={{ paddingBottom: spacing.huge * 2 }}
    >
      {/* --- Greeting + impact header ------------------------------------- */}
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="displaySmall" numberOfLines={2} testID="home-greeting">
              {home?.greeting ?? t('greetingMorning', { name: '' }).replace(/,\s*$/, '')}
            </Text>
            {home?.date ? (
              <Text variant="bodySmall" tone="secondary">
                {formatShortDate(home.date)}
              </Text>
            ) : null}
          </View>

          <View style={{ alignItems: 'flex-end', gap: spacing.xs }}>
            <View
              style={{
                width: sizes.avatarMd,
                height: sizes.avatarMd,
                borderRadius: radii.pill,
                backgroundColor: colors.primarySoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="person" size={sizes.iconMd} color={colors.primary} />
            </View>
            {home && home.level > 0 ? (
              <Badge label={`Lv ${home.level}`} tone="primary" size="sm" />
            ) : null}
          </View>
        </View>

        {isLoading ? (
          <SkeletonList count={2} />
        ) : (
          <StatGrid>
            <StatCard
              label={t('savingsTitle')}
              value={formatMoney(home?.money_saved_this_week ?? 0)}
              icon="wallet-outline"
              tone={colors.success}
              softTone={colors.successSoft}
              sublabel="this week"
              onPress={() => router.push('/waste')}
              compact
              testID="home-savings"
            />
            <StatCard
              label={t('co2Saved')}
              value={formatCo2(home?.co2_saved_this_week ?? 0)}
              icon="leaf-outline"
              tone={colors.primary}
              softTone={colors.primarySoft}
              sublabel="this week"
              onPress={() => router.push('/waste')}
              compact
              testID="home-co2"
            />
            <StatCard
              label={t('streak')}
              value={pluralize(home?.streak_days ?? 0, 'day')}
              icon="flame-outline"
              tone={colors.warning}
              softTone={colors.warningSoft}
              sublabel={home?.waste_free_days ? `${home.waste_free_days} waste-free` : undefined}
              onPress={() => router.push('/achievements')}
              compact
              testID="home-streak"
            />
            <StatCard
              label="Points"
              value={String(home?.points ?? 0)}
              icon="trophy-outline"
              tone={colors.accent}
              softTone={colors.accentSoft}
              sublabel={home?.level_label}
              onPress={() => router.push('/achievements')}
              compact
              testID="home-points"
            />
          </StatGrid>
        )}
      </View>

      {/* --- Quick actions -------------------------------------------------- */}
      <View style={{ paddingHorizontal: spacing.lg }}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button label={t('scanFridge')} icon="camera" onPress={() => router.push('/(tabs)/scan')} size="sm" style={{ flex: 1 }} />
          <Button
            label={t('addPantryItem')}
            icon="add"
            variant="outline"
            onPress={() => router.push('/pantry?add=1')}
            size="sm"
            style={{ flex: 1 }}
          />
          <Button label="" icon="trash" variant="ghost" onPress={() => router.push('/waste?log=1')} size="sm" accessibilityLabel={t('logWaste')} />
        </View>
      </View>

      {/* --- Expiring soon --------------------------------------------------- */}
      <View style={{ gap: spacing.md }}>
        <View style={{ paddingHorizontal: spacing.lg }}>
          <SectionHeader title={t('expiringTitle')} action={t('viewAll')} onAction={() => router.push('/pantry?filter=expiring')} />
        </View>

        {isLoading ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <SkeletonList count={1} />
          </View>
        ) : expiring.length ? (
          <ExpiringCarousel
            items={expiring}
            testID="home-expiring"
            onPressItem={(item) => router.push(`/pantry?highlight=${item.id}`)}
            onPressRecipe={(item) => {
              if (item.suggested_recipe_id) router.push(`/recipe/${item.suggested_recipe_id}`);
              else router.push('/(tabs)/recipes');
            }}
          />
        ) : (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <Card padding="lg" style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Ionicons name="checkmark-circle" size={sizes.iconLg} color={colors.success} />
              <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
                {t('expiringEmpty')}
              </Text>
            </Card>
          </View>
        )}
      </View>

      {/* --- Today's plan ---------------------------------------------------- */}
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
        <SectionHeader title={t('todaysMeals')} action={t('viewAll')} onAction={() => router.push('/(tabs)/plan')} />

        {isLoading ? (
          <SkeletonList count={1} variant="card" />
        ) : todaysMeals.length ? (
          <Card padding="lg" style={{ gap: spacing.xs }} testID="home-today">
            {todaysMeals.map((meal) => (
              <View
                key={meal.entry_id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingVertical: spacing.sm,
                  borderTopWidth: meal === todaysMeals[0] ? 0 : sizes.dividerHeight,
                  borderTopColor: colors.divider,
                }}
              >
                <View style={{ width: 26, alignItems: 'center' }}>
                  <Ionicons
                    name={meal.completed ? 'checkmark-circle' : 'ellipse-outline'}
                    size={sizes.iconMd}
                    color={meal.completed ? colors.success : colors.borderStrong}
                  />
                </View>

                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="captionSmall" tone="tertiary">
                    {meal.meal_type.charAt(0).toUpperCase() + meal.meal_type.slice(1)}
                  </Text>
                  <Text
                    variant="bodyMedium"
                    numberOfLines={1}
                    tone={meal.completed ? 'tertiary' : 'default'}
                    style={meal.completed ? { textDecorationLine: 'line-through' } : undefined}
                  >
                    {meal.title}
                  </Text>
                  <Text variant="captionSmall" tone="tertiary">
                    {meal.total_time_min ? `${meal.total_time_min} min` : null}
                    {meal.total_time_min && meal.servings ? ' · ' : null}
                    {meal.servings ? `${meal.servings} servings` : null}
                  </Text>
                </View>

                {meal.recipe_id ? (
                  <Button
                    label=""
                    icon="chevron-forward"
                    variant="ghost"
                    size="sm"
                    onPress={() => router.push(`/recipe/${meal.recipe_id}`)}
                    accessibilityLabel={`Open ${meal.title}`}
                  />
                ) : null}
              </View>
            ))}
          </Card>
        ) : (
          <Card padding="xl" style={{ gap: spacing.md, alignItems: 'center' }}>
            <Ionicons name="calendar-outline" size={40} color={colors.textTertiary} />
            <Text variant="bodySmall" tone="secondary" align="center">
              {t('todaysMealsEmpty')}
            </Text>
            <Button label={t('planWeek')} icon="calendar" size="sm" onPress={() => router.push('/(tabs)/plan')} />
          </Card>
        )}
      </View>

      {/* --- Pantry snapshot ------------------------------------------------- */}
      {pantry ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Card padding="lg" style={{ gap: spacing.sm }} onPress={() => router.push('/pantry')} testID="home-pantry">
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
              <Text variant="headingSmall">{t('pantryTitle')}</Text>
              <Text variant="caption" tone="secondary">
                {t('pantryCount', { count: pantry.total_items })}
              </Text>
            </View>

            <ProgressBar
              value={pantryProgress}
              color={pantry.expiring_soon_count > 0 ? colors.secondary : colors.primary}
              height={sizes.progressHeightSm}
              accessibilityLabel={`${pantry.expiring_soon_count} of ${pantry.total_items} items expiring soon`}
            />

            <View style={{ flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' }}>
              {pantry.expiring_soon_count > 0 ? (
                <Text variant="captionSmall" tone="secondary">
                  ⚠️ {t('pantryExpiring', { count: pantry.expiring_soon_count })}
                </Text>
              ) : null}
              {pantry.expired_count > 0 ? (
                <Text variant="captionSmall" tone="danger">
                  {pluralize(pantry.expired_count, 'item')} expired
                </Text>
              ) : null}
              {pantry.estimated_value > 0 ? (
                <Text variant="captionSmall" tone="tertiary">
                  Worth about {formatMoney(pantry.estimated_value)}
                </Text>
              ) : null}
            </View>
          </Card>
        </View>
      ) : null}

      {/* --- Recipe suggestions --------------------------------------------- */}
      <View style={{ gap: spacing.md }}>
        <View style={{ paddingHorizontal: spacing.lg }}>
          <SectionHeader title={t('suggestionsTitle')} action={t('viewAll')} onAction={() => router.push('/(tabs)/recipes')} />
        </View>

        {isLoading ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <SkeletonList count={2} variant="card" />
          </View>
        ) : suggestions.length ? (
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            {suggestions.slice(0, 3).map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                layout="horizontal"
                onPress={() => router.push(`/recipe/${recipe.id}`)}
                testID={`home-recipe-${recipe.id}`}
              />
            ))}
          </View>
        ) : (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <EmptyState
              icon="restaurant-outline"
              title="No suggestions yet"
              description="Add a few things to your pantry and PlateMatch will rank recipes by what you can cook right now."
              actionLabel="Open pantry"
              onAction={() => router.push('/pantry')}
              compact
            />
          </View>
        )}
      </View>

      {/* --- Activity snapshot ---------------------------------------------- */}
      {snapshot ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Card padding="lg" style={{ flexDirection: 'row', gap: spacing.md }}>
            <SnapshotStat icon="camera-outline" value={snapshot.scans_completed} label="Scans" />
            <SnapshotStat icon="restaurant-outline" value={snapshot.meals_cooked} label="Cooked" />
            <SnapshotStat
              icon="trophy-outline"
              value={snapshot.achievements_earned}
              label={`of ${snapshot.achievements_total} badges`}
            />
          </Card>
        </View>
      ) : null}

      {/* --- Premium nudge -------------------------------------------------- */}
      {home?.show_upgrade_prompt ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Card
            onPress={() => router.push('/premium')}
            padding="xl"
            style={{ gap: spacing.sm, backgroundColor: colors.text }}
            testID="home-premium-nudge"
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="sparkles" size={sizes.iconMd} color={colors.secondary} />
              <Text variant="caption" style={{ color: colors.secondary }}>
                PREMIUM
              </Text>
            </View>
            <Text variant="headingSmall" style={{ color: colors.textInverse }}>
              Unlimited scans and recipes
            </Text>
            <Text variant="bodySmall" style={{ color: 'rgba(255,255,255,0.7)' }}>
              Plus multi-store price comparison that usually pays for itself on the first shop.
            </Text>
          </Card>
        </View>
      ) : null}

      {home?.date ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Text variant="captionSmall" tone="tertiary" align="center">
            Updated {formatShortDate(home.date)}
          </Text>
        </View>
      ) : null}
    </Screen>
  );
}

function SnapshotStat({ icon, value, label }: { icon: keyof typeof Ionicons.glyphMap; value: number; label: string }): React.ReactElement {
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <Ionicons name={icon} size={sizes.iconSm} color={colors.textTertiary} />
      <Text variant="statSmall">{value}</Text>
      <Text variant="captionSmall" tone="tertiary" align="center" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
