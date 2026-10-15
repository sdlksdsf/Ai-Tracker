import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PantryItemDto } from '@platematch/shared';
import {
  categoryColor,
  categoryIcon,
  colors,
  radii,
  sizes,
  spacing,
  urgencyBackgrounds,
  urgencyColors,
  type Urgency,
} from '../theme/tokens.js';
import { Text } from './ui/Text.js';
import { Badge } from './ui/Badge.js';
import { formatQuantityLabel } from '../lib/format.js';

/**
 * Pantry row (Section 6, Screen 9).
 *
 * The left rail is coloured by expiry urgency, not by category: on this screen
 * the question the user is answering is "what needs using?", so the danger
 * signal gets the most prominent position and the category lives in the icon.
 */

export interface PantryItemRowProps {
  item: PantryItemDto;
  onPress?: () => void;
  onUse?: () => void;
  onLongPress?: () => void;
  /** Show the "use up" check on the right. */
  showUseAction?: boolean;
  /** Render compactly inside a carousel. */
  compact?: boolean;
  selected?: boolean;
  testID?: string;
}

export function PantryItemRow({
  item,
  onPress,
  onUse,
  onLongPress,
  showUseAction = true,
  compact = false,
  selected = false,
  testID,
}: PantryItemRowProps): React.ReactElement {
  const urgency = (item.urgency ?? 'none') as Urgency;
  const railColor = urgencyColors[urgency] ?? colors.textTertiary;
  const badgeColor = urgencyBackgrounds[urgency] ?? colors.divider;

  const isExpired = urgency === 'expired';
  const isUsed = item.is_used;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress}
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${item.ingredient_name}, ${item.quantity != null ? formatQuantityLabel(item.quantity, item.unit) : 'quantity not recorded'}, ${item.expiry_label}`}
      accessibilityState={{ selected, disabled: !onPress }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          paddingVertical: compact ? spacing.sm : spacing.md,
          paddingHorizontal: spacing.md,
          borderRadius: radii.md,
          backgroundColor: selected ? colors.primarySoft : colors.surface,
          borderWidth: sizes.borderWidth,
          borderColor: selected ? colors.primary : colors.border,
          opacity: isUsed ? 0.55 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {/* Urgency rail */}
      <View style={{ width: 4, alignSelf: 'stretch', minHeight: compact ? 32 : 44, borderRadius: radii.pill, backgroundColor: railColor }} />

      {/* Category icon — tinted with the category colour at low weight so the
          urgency rail stays the dominant signal. */}
      <View
        style={{
          width: compact ? 36 : sizes.thumbnailSm,
          height: compact ? 36 : sizes.thumbnailSm,
          borderRadius: radii.sm,
          backgroundColor: badgeColor,
          borderLeftWidth: 3,
          borderLeftColor: categoryColor(item.category),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: compact ? 16 : 20 }}>{categoryIcon(item.category)}</Text>
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant={compact ? 'bodySmall' : 'bodyMedium'} numberOfLines={1} style={isUsed ? { textDecorationLine: 'line-through' } : undefined}>
          {item.ingredient_name}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Text variant="captionSmall" tone="tertiary">
            {formatQuantityLabel(item.quantity, item.unit)}
          </Text>
          {item.location ? (
            <Text variant="captionSmall" tone="tertiary">
              · {capitalize(item.location)}
            </Text>
          ) : null}
          <Text
            variant="captionSmall"
            style={{ color: railColor }}
            testID={testID ? `${testID}-expiry` : undefined}
          >
            {item.expiry_label}
          </Text>
        </View>
      </View>

      {isExpired ? (
        <Badge label="Expired" tone="danger" size="sm" />
      ) : showUseAction && onUse && !isUsed ? (
        <Pressable
          onPress={onUse}
          hitSlop={spacing.sm}
          accessibilityRole="button"
          accessibilityLabel={`Mark ${item.ingredient_name} as used`}
          testID={testID ? `${testID}-use` : undefined}
          style={({ pressed }) => [
            {
              width: 34,
              height: 34,
              borderRadius: radii.pill,
              borderWidth: sizes.borderWidthThick,
              borderColor: pressed ? colors.primaryDark : colors.border,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.surface,
            },
          ]}
        >
          <Ionicons name="checkmark" size={sizes.iconSm} color={colors.primary} />
        </Pressable>
      ) : isUsed ? (
        <Ionicons name="checkmark-circle" size={sizes.iconMd} color={colors.success} />
      ) : null}

    </Pressable>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default PantryItemRow;
