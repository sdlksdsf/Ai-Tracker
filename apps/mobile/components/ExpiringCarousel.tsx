import React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ExpiringSoonItemDto } from '@platematch/shared';
import { categoryIcon, colors, radii, sizes, spacing, urgencyColors, type Urgency } from '../theme/tokens.js';
import { Text } from './ui/Text.js';
import { formatQuantityLabel, formatRelativeDays } from '../lib/format.js';

/**
 * Expiring-soon carousel (Section 6, Screen 2).
 *
 * The single most actionable thing on the Home screen: each card pairs an item
 * about to go off with a recipe that uses it, so the next tap resolves the
 * problem rather than just reporting it.
 */

export interface ExpiringCarouselProps {
  items: ExpiringSoonItemDto[];
  onPressItem?: (item: ExpiringSoonItemDto) => void;
  /** Tapping the recipe link goes straight to the recipe. */
  onPressRecipe?: (item: ExpiringSoonItemDto) => void;
  testID?: string;
}

export function ExpiringCarousel({ items, onPressItem, onPressRecipe, testID }: ExpiringCarouselProps): React.ReactElement {
  return (
    <FlatList
      testID={testID}
      horizontal
      data={items}
      keyExtractor={(item) => item.id}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing.md, paddingHorizontal: spacing.lg }}
      renderItem={({ item }) => <ExpiringCard item={item} onPress={onPressItem} onPressRecipe={onPressRecipe} />}
      ListEmptyComponent={null}
    />
  );
}

function ExpiringCard({
  item,
  onPress,
  onPressRecipe,
}: {
  item: ExpiringSoonItemDto;
  onPress?: (item: ExpiringSoonItemDto) => void;
  onPressRecipe?: (item: ExpiringSoonItemDto) => void;
}): React.ReactElement {
  const urgency = (item.urgency ?? 'soon') as Urgency;
  const accent = urgencyColors[urgency] ?? colors.secondary;
  const isExpired = urgency === 'expired';
  const isToday = item.days_until_expiry === 0;

  return (
    <Pressable
      onPress={() => onPress?.(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.ingredient_name}, ${item.expiry_label}${item.suggested_recipe_title ? `, suggested recipe ${item.suggested_recipe_title}` : ''}`}
      style={({ pressed }) => [
        {
          width: 208,
          gap: spacing.sm,
          padding: spacing.md,
          borderRadius: radii.md,
          backgroundColor: colors.surface,
          borderWidth: sizes.borderWidth,
          borderColor: colors.border,
          borderLeftWidth: 4,
          borderLeftColor: accent,
          opacity: pressed ? 0.88 : 1,
        },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: radii.sm,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 17 }}>{categoryIcon(item.category)}</Text>
        </View>

        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {item.ingredient_name}
          </Text>
          <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
            {formatQuantityLabel(item.quantity, item.unit)}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Ionicons
          name={isExpired ? 'close-circle' : isToday ? 'alert-circle' : 'time-outline'}
          size={sizes.iconXs}
          color={accent}
        />
        <Text variant="caption" style={{ color: accent }}>
          {isExpired ? 'Expired' : isToday ? 'Use today' : formatRelativeDays(item.days_until_expiry)}
        </Text>
      </View>

      {item.suggested_recipe_title ? (
        <Pressable
          onPress={() => onPressRecipe?.(item)}
          hitSlop={spacing.xs}
          accessibilityRole="link"
          accessibilityLabel={`Cook ${item.suggested_recipe_title}`}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingVertical: 6,
              paddingHorizontal: spacing.sm,
              borderRadius: radii.sm,
              backgroundColor: colors.primarySoft,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Ionicons name="restaurant-outline" size={sizes.iconXs} color={colors.primary} />
          <Text variant="captionSmall" tone="primary" numberOfLines={1} style={{ flex: 1 }}>
            {item.suggested_recipe_title}
          </Text>
          <Ionicons name="chevron-forward" size={11} color={colors.primary} />
        </Pressable>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 }}>
          <Ionicons name="search-outline" size={sizes.iconXs} color={colors.textTertiary} />
          <Text variant="captionSmall" tone="tertiary">
            Find a recipe
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export default ExpiringCarousel;
