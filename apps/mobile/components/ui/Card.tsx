import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, elevation, radii, spacing } from '../../theme/tokens.js';

/**
 * Surface primitive.
 *
 * A card is the background for nearly every grouped piece of content in the app.
 * `onPress` swaps the underlying `View` for a `Pressable` and adds the pressed
 * state, so callers do not have to wrap a card in a touchable themselves.
 */

export interface CardProps {
  children?: React.ReactNode;
  /** Removes the default padding for edge-to-edge content (images, lists). */
  flush?: boolean;
  /** Draws a border instead of a shadow — used for dense nested cards. */
  outlined?: boolean;
  /** Tints the surface, e.g. `colors.successSoft` for a savings callout. */
  tone?: string;
  elevated?: keyof typeof elevation;
  radius?: keyof typeof radii;
  padding?: keyof typeof spacing;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

export function Card({
  children,
  flush = false,
  outlined = false,
  tone,
  elevated = 'level1',
  radius = 'md',
  padding = 'lg',
  onPress,
  onLongPress,
  disabled = false,
  selected = false,
  style,
  contentStyle,
  accessibilityLabel,
  testID,
}: CardProps): React.ReactElement {
  const baseStyle: StyleProp<ViewStyle> = [
    {
      backgroundColor: tone ?? colors.surface,
      borderRadius: radii[radius],
      borderWidth: outlined || selected ? 1 : 0,
      borderColor: selected ? colors.primary : colors.border,
      overflow: 'hidden',
    },
    // A flat card needs no shadow; an outlined one uses the border instead.
    outlined ? null : elevation[elevated],
    disabled ? { opacity: 0.55 } : null,
    style,
  ];

  const inner = (
    <>
      <View style={[flush ? null : { padding: spacing[padding] }, contentStyle]}>{children}</View>
    </>
  );

  if (!onPress) {
    return (
      <View style={baseStyle} testID={testID} accessibilityLabel={accessibilityLabel}>
        {inner}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      style={({ pressed }) => [baseStyle, pressed && !disabled ? { opacity: 0.85, transform: [{ scale: 0.99 }] } : null]}
    >
      {inner}
    </Pressable>
  );
}

export default Card;
