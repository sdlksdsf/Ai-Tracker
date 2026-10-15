import React from 'react';
import { Pressable, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing, typography } from '../../theme/tokens.js';
import { Text } from './Text.js';

/**
 * Chip — filter pill and multi-select tag (Section 6, Screens 5/9/10).
 *
 * Used for cuisine filters, diet toggles, meal-type selection and ingredient
 * tags. `selected` drives both the fill and the checkmark so the two can never
 * disagree.
 */

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Tint override, e.g. a category colour. */
  color?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Chip({
  label,
  selected = false,
  onPress,
  onRemove,
  icon,
  color,
  disabled = false,
  size = 'md',
  style,
  testID,
}: ChipProps): React.ReactElement {
  const accent = color ?? colors.primary;
  const height = size === 'sm' ? 30 : 36;
  const font = size === 'sm' ? typography.caption : typography.caption;

  const containerStyle: StyleProp<ViewStyle> = [
    {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      height,
      paddingHorizontal: size === 'sm' ? spacing.md : spacing.lg,
      borderRadius: radii.pill,
      backgroundColor: selected ? accent : colors.surface,
      borderWidth: sizes.borderWidth,
      borderColor: selected ? accent : colors.border,
      opacity: disabled ? 0.5 : 1,
    },
    style,
  ];

  const content = (
    <>
      {icon ? (
        <Ionicons
          name={icon}
          size={size === 'sm' ? sizes.iconXs : sizes.iconSm}
          color={selected ? colors.textInverse : accent}
        />
      ) : null}
      <Text
        variant={size === 'sm' ? 'captionSmall' : 'caption'}
        style={[font, { color: selected ? colors.textInverse : colors.text }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={spacing.xs}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          testID={testID ? `${testID}-remove` : undefined}
        >
          <Ionicons
            name="close-circle"
            size={size === 'sm' ? sizes.iconXs : sizes.iconSm}
            color={selected ? colors.textInverse : colors.textTertiary}
          />
        </Pressable>
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View style={containerStyle} testID={testID} accessibilityLabel={label}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled, checked: selected }}
      style={({ pressed }) => [containerStyle, pressed && !disabled ? { opacity: 0.75 } : null]}
    >
      {content}
    </Pressable>
  );
}

/** Horizontally scrolling row of chips — the filter bar under a screen title. */
export function ChipRow({
  children,
  style,
  contentContainerStyle,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}): React.ReactElement {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={style}
      contentContainerStyle={[{ gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs }, contentContainerStyle]}
    >
      {children}
    </ScrollView>
  );
}

export default Chip;
