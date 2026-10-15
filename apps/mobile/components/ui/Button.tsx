import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  View,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, motion, radii, sizes, spacing, typography } from '../../theme/tokens.js';
import { Text } from './Text.js';
import { useUiStore } from '../../stores/ui.store.js';

/**
 * Button.
 *
 * Variants map to the intent hierarchy in Section 6: one `primary` action per
 * screen, `secondary` for the next most likely choice, and `ghost`/`danger` for
 * everything else. The loading state keeps the button's width fixed so a screen
 * does not reflow while a request is in flight.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ionicons name, rendered before the label. */
  icon?: keyof typeof Ionicons.glyphMap;
  iconRight?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  /** Fill the available width — used for primary form actions. */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** Defaults to "button"; icon-only toggles should pass "checkbox". */
  accessibilityRole?: AccessibilityRole;
  testID?: string;
  /** Fire light haptic feedback on press. */
  haptic?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: colors.primary, fg: colors.textInverse },
  secondary: { bg: colors.secondary, fg: colors.textInverse },
  outline: { bg: 'transparent', fg: colors.primary, border: colors.primary },
  ghost: { bg: 'transparent', fg: colors.primary },
  danger: { bg: colors.danger, fg: colors.textInverse },
  success: { bg: colors.success, fg: colors.textInverse },
};

const SIZE_STYLES: Record<ButtonSize, { height: number; paddingX: number; font: keyof typeof typography; iconSize: number; gap: number }> = {
  sm: { height: sizes.buttonHeightSm, paddingX: spacing.md, font: 'buttonSmall', iconSize: sizes.iconSm, gap: spacing.xs },
  md: { height: sizes.buttonHeight, paddingX: spacing.xl, font: 'button', iconSize: sizes.iconMd, gap: spacing.sm },
  lg: { height: sizes.buttonHeightLg, paddingX: spacing.xxl, font: 'button', iconSize: sizes.iconMd, gap: spacing.sm },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  block = false,
  style,
  accessibilityLabel,
  accessibilityRole = 'button',
  testID,
  haptic = true,
}: ButtonProps): React.ReactElement {
  const tap = useUiStore((state) => state.tap);
  const palette = VARIANT_STYLES[variant];
  const dimensions = SIZE_STYLES[size];
  const isDisabled = disabled || loading;

  const handlePress = (): void => {
    if (isDisabled || !onPress) return;
    if (haptic) tap();
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        {
          height: dimensions.height,
          minHeight: sizes.touchTarget,
          paddingHorizontal: dimensions.paddingX,
          borderRadius: radii.md,
          backgroundColor: palette.bg,
          borderWidth: palette.border ? sizes.borderWidthThick : 0,
          borderColor: palette.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: dimensions.gap,
          opacity: isDisabled ? 0.5 : pressed ? 0.88 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.98 : 1 }],
        },
        block ? { alignSelf: 'stretch', width: '100%' } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={dimensions.iconSize} color={palette.fg} /> : null}
          <Text variant={dimensions.font} style={{ color: palette.fg }} numberOfLines={1}>
            {label}
          </Text>
          {iconRight ? <Ionicons name={iconRight} size={dimensions.iconSize} color={palette.fg} /> : null}
        </>
      )}
    </Pressable>
  );
}

/** Round icon-only button, used in headers and as a row action. */
export interface IconButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  size?: 'sm' | 'md' | 'lg';
  tone?: string;
  background?: string;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const ICON_SIZES = { sm: sizes.iconSm, md: sizes.iconMd, lg: sizes.iconLg } as const;
const ICON_BOXES = { sm: 34, md: 40, lg: sizes.touchTarget } as const;

export function IconButton({
  icon,
  onPress,
  size = 'md',
  tone = colors.text,
  background = 'transparent',
  disabled = false,
  loading = false,
  accessibilityLabel,
  testID,
  style,
}: IconButtonProps): React.ReactElement {
  const tap = useUiStore((state) => state.tap);

  return (
    <Pressable
      onPress={() => {
        if (disabled || loading || !onPress) return;
        tap();
        onPress();
      }}
      disabled={disabled || loading}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      hitSlop={spacing.xs}
      style={({ pressed }) => [
        {
          width: ICON_BOXES[size],
          height: ICON_BOXES[size],
          borderRadius: radii.pill,
          backgroundColor: background,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tone} />
      ) : (
        <Ionicons name={icon} size={ICON_SIZES[size]} color={tone} />
      )}
    </Pressable>
  );
}

/** Text-only button for tertiary actions inside a row. */
export function LinkButton({
  label,
  onPress,
  tone = colors.primary,
  disabled = false,
  testID,
}: {
  label: string;
  onPress?: () => void;
  tone?: string;
  disabled?: boolean;
  testID?: string;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={spacing.sm}
      style={({ pressed }) => [{ opacity: disabled ? 0.4 : pressed ? 0.6 : 1, paddingVertical: spacing.xs }]}
    >
      <Text variant="bodyMedium" style={{ color: tone }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A row of buttons with consistent spacing. */
export function ButtonRow({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  return (
    <View style={[{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }, style]}>{children}</View>
  );
}

export default Button;
