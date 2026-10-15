import React, { useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type { DayMealEntry, DayMeals, MealPlanEntryDto, WeekOverviewDto } from '@platematch/shared';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen, SectionHeader } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Chip } from '../../components/ui/Chip.js';
import { OptionSheet, type SheetOption } from '../../components/ui/Sheet.js';
import { Sheet } from '../../components/ui/Sheet.js';
import { ProgressBar, MacroBar } from '../../components/ui/Progress.js';
import { BarChart } from '../../components/charts/BarChart.js';
import { MealDayCard } from '../../components/MealDayCard.js';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { toast } from '../../stores/ui.store.js';
import { useCompleteMeal, useGenerateMealPlan, useSwapMeal, useWeekOverview } from '../../hooks/useApi.js';
import { formatDate } from '../../lib/format.js';

/**
 * Meal plan (Section 6, Screen 10).
 *
 * The week view is the anchor: seven day cards, a calorie bar per day against the
 * user's target, and a swap/complete action on every meal. Generating a plan is a
 * single prominent action rather than buried in a menu, because an empty week is
 * the state every new user starts in.
 */

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

/**
 * `WeekOverviewDto.days[].meals` is a flat array; `MealDayCard` wants the
 * `day → { breakfast, lunch, dinner, snack }` record the `/days` endpoint
 * returns. Converting here keeps the component tied to one shape.
 */
function toDayMealEntry(day: WeekOverviewDto['days'][number], index: number): DayMealEntry {
  const meals: DayMeals = { breakfast: null, lunch: null, dinner: null, snack: null };

  for (const entry of day.meals) {
    const mealType = entry.meal_type as keyof DayMeals;
    if (mealType in meals && !meals[mealType]) meals[mealType] = entry;
  }

  return {
    day: index + 1,
    date: day.date,
    meals,
    day_name: day.day_name,
    is_today: day.is_today,
    total_calories: day.total_calories,
  };
}

export default function PlanScreen(): React.ReactElement {
  const { t } = useTranslation('plan');
  const router = useRouter();

  const { data: week, isLoading, isError, error, refetch, isRefetching } = useWeekOverview();
  const generate = useGenerateMealPlan();
  const swapMeal = useSwapMeal();
  const completeMeal = useCompleteMeal();

  const [showGenerate, setShowGenerate] = useState(false);
  const [swapTarget, setSwapTarget] = useState<{ entryId: string; day: number; mealType: string } | null>(null);

  // Generation options
  const [days, setDays] = useState(7);
  const [mealsPerDay, setMealsPerDay] = useState(3);
  const [variety, setVariety] = useState<'low' | 'medium' | 'high'>('high');
  const [cookingTime, setCookingTime] = useState<'quick' | 'balanced' | 'elaborate'>('balanced');
  const [daysSheet, setDaysSheet] = useState(false);
  const [mealsSheet, setMealsSheet] = useState(false);

  const daysOptions: Array<SheetOption<string>> = useMemo(
    () => [
      { value: '3', label: '3 days', description: 'A long weekend' },
      { value: '5', label: '5 days', description: 'Weekday cooking' },
      { value: '7', label: '7 days', description: 'The full week' },
      { value: '14', label: '14 days', description: 'Two weeks of batch cooking' },
    ],
    [],
  );

  const mealsOptions: Array<SheetOption<string>> = useMemo(
    () => [
      { value: '1', label: 'Dinner only', description: 'One decision a day' },
      { value: '2', label: 'Lunch + dinner' },
      { value: '3', label: 'Breakfast, lunch + dinner' },
      { value: '4', label: 'All four meals', description: 'Includes snacks' },
    ],
    [],
  );

  const handleGenerate = async (): Promise<void> => {
    const startDate = new Date();
    // Plans start on the next Monday so the week view lines up with the calendar.
    const dayOfWeek = (startDate.getUTCDay() + 6) % 7;
    startDate.setUTCDate(startDate.getUTCDate() - dayOfWeek);
    const startIso = startDate.toISOString().slice(0, 10);

    try {
      const result = await generate.mutateAsync({
        start_date: startIso,
        days,
        meals_per_day: mealsPerDay,
        variety,
        cooking_time_pref: cookingTime,
        exclude_recipe_ids: [],
        include_recipe_ids: [],
      });

      const verification = result.nutrition_verification;
      if (verification.warnings.length) {
        toast(verification.warnings[0]!, 'warning', { durationMs: 6000 });
      } else {
        toast(
          `${verification.days_within_tolerance}/${verification.days_checked} days within ±${verification.tolerance_pct}% of your target`,
          'success',
        );
      }

      setShowGenerate(false);
      await refetch();
    } catch (err) {
      toast((err as Error).message, 'error', { durationMs: 6000 });
    }
  };

  const handleComplete = async (entry: MealPlanEntryDto): Promise<void> => {
    if (!week?.meal_plan_id) return;
    await completeMeal.mutateAsync({
      planId: week.meal_plan_id,
      entryId: entry.id,
      input: { day: entry.day_of_week, meal_type: entry.meal_type, is_completed: !entry.is_completed, consume_pantry: true },
    });
    await refetch();
  };

  const handleSwap = async (aiReplace: boolean): Promise<void> => {
    if (!swapTarget || !week?.meal_plan_id) return;

    try {
      await swapMeal.mutateAsync({
        planId: week.meal_plan_id,
        entryId: swapTarget.entryId,
        input: {
          day: swapTarget.day,
          meal_type: swapTarget.mealType as 'breakfast' | 'lunch' | 'dinner' | 'snack',
          ai_replace: aiReplace,
        },
      });
      await refetch();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSwapTarget(null);
    }
  };

  if (isError && !week) {
    return (
      <Screen header={{ title: t('title'), large: true }} testID="plan-screen">
        <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const targets = week?.targets;
  const macroCheck = week?.macro_check ?? [];

  return (
    <Screen
      header={{ title: t('title'), subtitle: week ? `${formatDate(week.week_start)} — ${formatDate(week.week_end)}` : undefined, large: true }}
      padding={false}
      testID="plan-screen"
      scrollProps={{
        refreshControl: <RefreshControl refreshing={isRefetching && !isLoading} onRefresh={() => void refetch()} tintColor={colors.primary} colors={[colors.primary]} />,
      }}
      contentStyle={{ paddingBottom: spacing.huge * 2 }}
      footer={
        week?.meal_plan_id && week.days.some((day) => day.meals.length) ? (
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button label="Grocery list" icon="cart-outline" variant="outline" onPress={() => router.push('/grocery/latest')} style={{ flex: 1 }} />
            <Button label="Regenerate" icon="refresh" onPress={() => setShowGenerate(true)} style={{ flex: 1 }} />
          </View>
        ) : (
          <Button label={t('generate')} icon="sparkles" onPress={() => setShowGenerate(true)} block size="lg" loading={generate.isPending} testID="plan-generate" />
        )
      }
    >
      {isLoading ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <SkeletonList count={3} variant="card" />
        </View>
      ) : !week || !week.meal_plan_id ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <EmptyState
            icon="calendar-outline"
            tone="primary"
            title={t('noPlanTitle')}
            description={t('noPlanBody')}
            actionLabel={t('generate')}
            onAction={() => setShowGenerate(true)}
            testID="plan-empty"
          />
        </View>
      ) : (
        <>
          {/* --- Week summary ------------------------------------------- */}
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            <Card padding="xl" style={{ gap: spacing.lg }}>
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <SummaryStat value={`${Math.round(week.average_daily_calories)}`} label="avg kcal/day" />
                <SummaryStat value={`${week.completion_rate}%`} label="cooked" />
                <SummaryStat value={String(week.days.filter((day) => day.meals.length).length)} label="days planned" />
              </View>

              {targets?.calories ? (
                <View style={{ gap: spacing.sm }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text variant="caption" tone="secondary">
                      Daily target
                    </Text>
                    <Text variant="caption">{Math.round(targets.calories)} kcal</Text>
                  </View>
                  <ProgressBar
                    value={targets.calories > 0 ? week.average_daily_calories / targets.calories : 0}
                    color={Math.abs(week.average_daily_calories - targets.calories) / targets.calories <= 0.1 ? colors.success : colors.warning}
                    accessibilityLabel={`Average ${Math.round(week.average_daily_calories)} of ${Math.round(targets.calories)} calories`}
                  />
                </View>
              ) : null}

              {macroCheck.length ? (
                <View style={{ gap: spacing.sm }}>
                  <Text variant="caption" tone="secondary">
                    Calories by day
                  </Text>
                  <BarChart
                    data={week.days.map((day, index) => {
                      const check = macroCheck[index];
                      return {
                        label: day.day_name,
                        value: day.total_calories,
                        muted: day.total_calories === 0,
                        color: check?.within_tolerance === false ? colors.warning : colors.primary,
                      };
                    })}
                    referenceValue={targets?.calories}
                    referenceLabel={targets?.calories ? `Target ${Math.round(targets.calories)} kcal` : undefined}
                    height={110}
                    testID="plan-calorie-chart"
                  />
                </View>
              ) : null}

              {week.grocery_list_id ? (
                <Card
                  outlined
                  padding="md"
                  onPress={() => router.push(`/grocery/${week.grocery_list_id}`)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
                >
                  <Ionicons name="cart-outline" size={sizes.iconMd} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text variant="caption" tone="secondary">
                      {t('groceryPreview')}
                    </Text>
                    <Text variant="captionSmall" tone="tertiary">
                      Tap to open the shopping list
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
                </Card>
              ) : null}
            </Card>
          </View>

          {/* --- Day cards ------------------------------------------------ */}
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            <SectionHeader title="This week" />

            {week.days.map((day, index) => (
              <View key={day.date} style={{ gap: spacing.sm }}>
                <MealDayCard
                  day={toDayMealEntry(day, index)}
                  testID={`plan-day-${index + 1}`}
                  onPressMeal={(entry) => {
                    if (entry.recipe_id) router.push(`/recipe/${entry.recipe_id}`);
                  }}
                  onCompleteMeal={(entry) => void handleComplete(entry)}
                  onSwapMeal={(dayNumber, mealType) => {
                    const target = day.meals.find((meal) => meal.meal_type === mealType);
                    if (target) setSwapTarget({ entryId: target.id, day: dayNumber, mealType });
                    else toast('That slot is empty — regenerate the day to fill it', 'warning');
                  }}
                />

                {/* Per-day calorie readout */}
                {day.total_calories > 0 ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs }}>
                    <Text variant="captionSmall" tone="tertiary" style={{ flex: 1 }}>
                      {Math.round(day.total_calories)} kcal
                      {targets?.calories ? ` of ${Math.round(targets.calories)}` : ''}
                    </Text>
                    {day.completed_count > 0 ? (
                      <Badge label={`${day.completed_count} cooked`} tone="success" size="sm" />
                    ) : null}
                    {macroCheck[index] && !macroCheck[index]!.within_tolerance ? (
                      <Badge
                        label={macroCheck[index]!.delta > 0 ? `${Math.round(macroCheck[index]!.delta)} over` : `${Math.abs(Math.round(macroCheck[index]!.delta))} under`}
                        tone="warning"
                        size="sm"
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            ))}
          </View>

          {/* --- Macro split for the week --------------------------------- */}
          {targets ? (
            <View style={{ paddingHorizontal: spacing.lg }}>
              <Card padding="lg" style={{ gap: spacing.md }}>
                <Text variant="headingSmall">{t('macros')}</Text>
                <MacroBar
                  protein={targets.protein}
                  carbs={targets.carbs}
                  fat={targets.fat}
                  testID="plan-macro-bar"
                />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <MacroLegend color={colors.primary} label={t('protein')} value={`${Math.round(targets.protein)}g`} />
                  <MacroLegend color={colors.accent} label={t('carbs')} value={`${Math.round(targets.carbs)}g`} />
                  <MacroLegend color={colors.secondary} label={t('fat')} value={`${Math.round(targets.fat)}g`} />
                </View>
              </Card>
            </View>
          ) : null}
        </>
      )}

      {/* --- Generation sheet --------------------------------------------- */}
      <Sheet
        visible={showGenerate}
        onClose={() => setShowGenerate(false)}
        title={t('generate')}
        subtitle={t('regeneratingHint')}
        testID="plan-generate-sheet"
        footer={
          <Button
            label={generate.isPending ? t('regenerating') : t('generate')}
            icon="sparkles"
            onPress={() => void handleGenerate()}
            loading={generate.isPending}
            block
            size="lg"
          />
        }
      >
        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            How many days?
          </Text>
          <Chip label={`${days} days`} icon="calendar-outline" selected onPress={() => setDaysSheet(true)} />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Meals per day
          </Text>
          <Chip label={`${mealsPerDay} meals`} icon="restaurant-outline" selected onPress={() => setMealsSheet(true)} />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Variety
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {(['low', 'medium', 'high'] as const).map((option) => (
              <Chip key={option} label={option.charAt(0).toUpperCase() + option.slice(1)} selected={variety === option} onPress={() => setVariety(option)} />
            ))}
          </View>
          <Text variant="captionSmall" tone="tertiary">
            High variety avoids repeating a recipe within the week.
          </Text>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Cooking time
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {(['quick', 'balanced', 'elaborate'] as const).map((option) => (
              <Chip key={option} label={option.charAt(0).toUpperCase() + option.slice(1)} selected={cookingTime === option} onPress={() => setCookingTime(option)} />
            ))}
          </View>
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: spacing.sm,
            padding: spacing.md,
            borderRadius: radii.sm,
            backgroundColor: colors.primarySoft,
          }}
        >
          <Ionicons name="shield-checkmark-outline" size={sizes.iconSm} color={colors.primary} />
          <Text variant="captionSmall" tone="secondary" style={{ flex: 1 }}>
            Your allergies and dietary preference are enforced after generation — any recipe containing an allergen is rejected whole, never silently edited.
          </Text>
        </View>
      </Sheet>

      <OptionSheet
        visible={daysSheet}
        onClose={() => setDaysSheet(false)}
        onSelect={(value) => setDays(Number(value))}
        options={daysOptions}
        selected={String(days)}
        title="How many days?"
      />

      <OptionSheet
        visible={mealsSheet}
        onClose={() => setMealsSheet(false)}
        onSelect={(value) => setMealsPerDay(Number(value))}
        options={mealsOptions}
        selected={String(mealsPerDay)}
        title="Meals per day"
      />

      {/* --- Swap sheet ---------------------------------------------------- */}
      <Sheet
        visible={Boolean(swapTarget)}
        onClose={() => setSwapTarget(null)}
        title={t('swapTitle')}
        subtitle={swapTarget ? `${swapTarget.mealType.charAt(0).toUpperCase()}${swapTarget.mealType.slice(1)} · day ${swapTarget.day}` : undefined}
        scrollable={false}
        testID="plan-swap-sheet"
      >
        <View style={{ gap: spacing.md }}>
          <Button
            label={t('swapAi')}
            icon="sparkles"
            onPress={() => void handleSwap(true)}
            loading={swapMeal.isPending}
            block
            size="lg"
          />
          <Text variant="captionSmall" tone="tertiary" align="center">
            The AI avoids everything else already in this week.
          </Text>
          <Button label="Browse my recipes" icon="book-outline" variant="outline" onPress={() => { setSwapTarget(null); router.push('/(tabs)/recipes'); }} block />
        </View>
      </Sheet>
    </Screen>
  );
}

function SummaryStat({ value, label }: { value: string; label: string }): React.ReactElement {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text variant="statSmall">{value}</Text>
      <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function MacroLegend({ color, label, value }: { color: string; label: string; value: string }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text variant="captionSmall" tone="secondary">
        {label}
      </Text>
      <Text variant="captionSmall">{value}</Text>
    </View>
  );
}
