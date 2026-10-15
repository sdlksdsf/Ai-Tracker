import React from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { DAY_SHORT_NAMES } from '@platematch/shared';
import type { DayMealEntry, DayOfWeek, MealPlanEntryDto } from '@platematch/shared';
import { colors, mealTypeEmoji, radii, sizes, spacing } from '../theme/tokens.js';
import { Card } from './ui/Card.js';
import { Text } from './ui/Text.js';
import { Badge } from './ui/Badge.js';
import { formatShortDate } from '../lib/format.js';

/**
 * Meal-plan day card (Section 6, Screen 10).
 *
 * One card per day of the week with breakfast/lunch/dinner slots. An empty slot
 * is rendered as an "add" affordance rather than hidden, so the user can see the
 * plan has a gap and fill it.
 */

export interface MealDayCardProps {
  day: DayMealEntry;
  onPressMeal?: (entry: MealPlanEntryDto) => void;
  onCompleteMeal?: (entry: MealPlanEntryDto) => void;
  onSwapMeal?: (dayNumber: number, mealType: string) => void;
  testID?: string;
}

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

export function MealDayCard({ day, onPressMeal, onCompleteMeal, onSwapMeal, testID }: MealDayCardProps): React.ReactElement {
  const activeMeals = MEAL_ORDER.filter((mealType) => day.meals[mealType]);
  const isPast = day.date ? new Date(`${day.date}T23:59:59Z`).getTime() < Date.now() : false;

  // The display fields are optional on the DTO — `/meal-plans/:id/days` supplies
  // them, but a caller may only have the bare `{ day, date, meals }` triple.
  // Derive a label rather than rendering an empty header.
  const dayNumber = Math.min(7, Math.max(1, day.day)) as DayOfWeek;
  const dayLabel = day.day_name ?? DAY_SHORT_NAMES[dayNumber];
  const isToday = day.is_today ?? false;
  const totalCalories = day.total_calories ?? 0;

  return (
    <Card
      padding="lg"
      style={[
        { gap: spacing.md },
        isToday ? { borderWidth: sizes.borderWidthThick, borderColor: colors.primary } : null,
        isPast && !isToday ? { opacity: 0.75 } : null,
      ]}
      testID={testID}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text variant="headingSmall">{dayLabel}</Text>
          {day.date ? (
            <Text variant="captionSmall" tone="tertiary">
              {formatShortDate(day.date)}
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {isToday ? <Badge label="Today" tone="primary" size="sm" /> : null}
          {totalCalories > 0 ? (
            <Text variant="captionSmall" tone="secondary">
              {Math.round(totalCalories)} kcal
            </Text>
          ) : null}
        </View>
      </View>

      {activeMeals.length === 0 ? (
        <Pressable
          onPress={() => onSwapMeal?.(day.day, 'dinner')}
          accessibilityRole="button"
          accessibilityLabel={`Plan a meal for ${dayLabel}`}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: spacing.sm,
              paddingVertical: spacing.lg,
              borderRadius: radii.sm,
              borderWidth: sizes.borderWidthThick,
              borderColor: colors.border,
              borderStyle: 'dashed',
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Ionicons name="add-circle-outline" size={sizes.iconMd} color={colors.primary} />
          <Text variant="bodySmall" tone="primary">
            Plan a meal
          </Text>
        </Pressable>
      ) : null}

      {activeMeals.map((mealType) => {
        const entry = day.meals[mealType];
        if (!entry) return null;

        return (
          <MealSlot
            key={`${day.day}-${mealType}`}
            mealType={mealType}
            entry={entry}
            onPress={onPressMeal ? () => onPressMeal(entry) : undefined}
            onComplete={onCompleteMeal ? () => onCompleteMeal(entry) : undefined}
            onSwap={onSwapMeal ? () => onSwapMeal(day.day, mealType) : undefined}
            testID={testID ? `${testID}-${mealType}` : undefined}
          />
        );
      })}
    </Card>
  );
}

function MealSlot({
  mealType,
  entry,
  onPress,
  onComplete,
  onSwap,
  testID,
}: {
  mealType: string;
  entry: MealPlanEntryDto;
  onPress?: () => void;
  onComplete?: () => void;
  onSwap?: () => void;
  testID?: string;
}): React.ReactElement {
  // `MealPlanEntryDto` nests the recipe; the entry itself only carries the plan
  // position, completion state and calorie total.
  const recipe = entry.recipe ?? null;
  const title = recipe?.title ?? 'Planned meal';
  const totalTime = recipe?.total_time_min ?? null;
  const servings = recipe?.servings ?? null;

  const image = recipe?.image_url ? (
    <Image
      source={{ uri: recipe.image_url }}
      style={{ width: 52, height: 52, borderRadius: radii.sm, backgroundColor: colors.skeleton }}
      contentFit="cover"
      transition={180}
    />
  ) : (
    <View
      style={{
        width: 52,
        height: 52,
        borderRadius: radii.sm,
        backgroundColor: colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: 20 }}>{mealTypeEmoji[mealType] ?? '🍽️'}</Text>
    </View>
  );

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopWidth: sizes.dividerHeight,
        borderTopColor: colors.divider,
      }}
    >
      <Pressable onPress={onPress} disabled={!onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 }} accessibilityRole="button" accessibilityLabel={`${mealType}: ${title}`}>
        {image}
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="captionSmall" tone="tertiary">
            {mealType.charAt(0).toUpperCase() + mealType.slice(1)}
          </Text>
          <Text variant="bodyMedium" numberOfLines={2} style={entry.is_completed ? { textDecorationLine: 'line-through', color: colors.textSecondary } : undefined}>
            {title}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 }}>
            {entry.calories ? (
              <Text variant="captionSmall" tone="tertiary">
                {Math.round(entry.calories)} kcal
              </Text>
            ) : null}
            {totalTime ? (
              <Text variant="captionSmall" tone="tertiary">
                · {totalTime} min
              </Text>
            ) : null}
            {servings ? (
              <Text variant="captionSmall" tone="tertiary">
                · {servings} servings
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
        {onSwap ? (
          <Pressable
            onPress={onSwap}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel={`Swap ${mealType}`}
            testID={testID ? `${testID}-swap` : undefined}
            style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1, padding: 4 }]}
          >
            <Ionicons name="swap-horizontal" size={sizes.iconSm} color={colors.textTertiary} />
          </Pressable>
        ) : null}

        {onComplete ? (
          <Pressable
            onPress={onComplete}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel={entry.is_completed ? `Undo ${mealType}` : `Mark ${mealType} as cooked`}
            accessibilityState={{ checked: entry.is_completed }}
            testID={testID ? `${testID}-complete` : undefined}
            style={({ pressed }) => [
              {
                width: 30,
                height: 30,
                borderRadius: radii.pill,
                backgroundColor: entry.is_completed ? colors.success : 'transparent',
                borderWidth: entry.is_completed ? 0 : sizes.borderWidthThick,
                borderColor: colors.border,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Ionicons name="checkmark" size={sizes.iconSm} color={entry.is_completed ? colors.textInverse : colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default MealDayCard;
