import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { GroceryListItemDto } from '@platematch/shared';
import { categoryIcon, colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Text } from './ui/Text.js';
import { Badge } from './ui/Badge.js';
import { formatMoney, formatQuantityLabel } from '../lib/format.js';

/**
 * Grocery row (Section 6, Screen 11).
 *
 * Built for one-handed use in a shop aisle: a 48dp tap target for the checkbox,
 * the quantity on one line, and the cheapest-store badge where the eye lands
 * after the name.
 */

export interface GroceryItemRowProps {
  item: GroceryListItemDto;
  onToggle?: () => void;
  onPress?: () => void;
  currency?: string;
  testID?: string;
}

export function GroceryItemRow({ item, onToggle, onPress, currency = 'USD', testID }: GroceryItemRowProps): React.ReactElement {
  const checked = item.is_purchased;
  const cheapest = item.cheapest_store;
  const savings = item.store_prices && item.store_prices.length > 1 ? cheapestSaving(item) : null;

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.md,
        backgroundColor: checked ? colors.surfaceAlt : colors.surface,
      }}
    >
      <Pressable
        onPress={onToggle}
        disabled={!onToggle}
        hitSlop={spacing.sm}
        // 48dp minimum tap target even though the visible box is smaller.
        style={({ pressed }) => [
          {
            width: sizes.touchTarget,
            height: sizes.touchTarget,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          },
        ]}
        accessibilityRole="checkbox"
        accessibilityLabel={`${checked ? 'Uncheck' : 'Check'} ${item.ingredient_name}`}
        accessibilityState={{ checked }}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: radii.sm,
            borderWidth: sizes.borderWidthThick,
            borderColor: checked ? colors.primary : colors.borderStrong,
            backgroundColor: checked ? colors.primary : colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked ? <Ionicons name="checkmark" size={sizes.iconSm} color={colors.textInverse} /> : null}
        </View>
      </Pressable>

      <Pressable
        onPress={onPress}
        disabled={!onPress}
        style={{ flex: 1, gap: 3 }}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={`${item.ingredient_name}, ${formatQuantityLabel(item.quantity, item.unit)}${item.estimated_price ? `, about ${formatMoney(item.estimated_price, currency)}` : ''}`}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <Text style={{ fontSize: 14 }}>{categoryIcon(item.category)}</Text>
          <Text
            variant="bodyMedium"
            numberOfLines={1}
            style={[{ flex: 1 }, checked ? { textDecorationLine: 'line-through', color: colors.textTertiary } : null]}
          >
            {item.ingredient_name}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Text variant="captionSmall" tone="tertiary">
            {formatQuantityLabel(item.quantity, item.unit)}
          </Text>

          {item.in_pantry ? (
            <Badge label="In pantry" tone="neutral" size="sm" icon="home-outline" />
          ) : null}

          {cheapest ? (
            <Badge label={cheapest} tone="accent" size="sm" icon="pricetag-outline" />
          ) : null}

          {savings && savings > 0.05 ? (
            <Text variant="captionSmall" tone="success">
              save {formatMoney(savings, currency)}
            </Text>
          ) : null}

          {item.needed_for_recipes?.length ? (
            <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
              · {item.needed_for_recipes.length} recipe{item.needed_for_recipes.length === 1 ? '' : 's'}
            </Text>
          ) : null}
        </View>
      </Pressable>

      {item.estimated_price != null ? (
        <Text variant="caption" style={{ minWidth: 58, textAlign: 'right' }}>
          {formatMoney(item.estimated_price, currency)}
        </Text>
      ) : (
        <View style={{ minWidth: 58 }} />
      )}
    </View>
  );
}

/** Price spread between the cheapest and most expensive store for this line. */
function cheapestSaving(item: GroceryListItemDto): number {
  const prices = (item.store_prices ?? []).map((price) => price.price).filter((price) => Number.isFinite(price));
  if (prices.length < 2) return 0;
  return Math.max(...prices) - Math.min(...prices);
}

/** Sticky group heading used when the list is grouped by category or aisle. */
export function GroceryGroupHeader({ title, count, cost, currency = 'USD' }: { title: string; count?: number; cost?: number; currency?: string }): React.ReactElement {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm,
        backgroundColor: colors.background,
        gap: spacing.sm,
      }}
    >
      <Text variant="overline" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
        {title}
      </Text>
      {count != null ? (
        <Text variant="captionSmall" tone="tertiary">
          {count}
        </Text>
      ) : null}
      {cost != null ? (
        <Text variant="captionSmall" tone="tertiary">
          {formatMoney(cost, currency)}
        </Text>
      ) : null}
    </View>
  );
}

export default GroceryItemRow;
