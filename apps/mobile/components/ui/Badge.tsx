import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing, typography } from '../../theme/tokens.js';
import { Text } from './Text.js';

/**
 * Badge — small status pill.
 *
 * Distinct from `Chip`: a badge is informational and never pressable. Used for
 * plan tier, scan status, "Premium only" gates and difficulty level.
 */

export type BadgeTone = 'neutral' | 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.divider, fg: colors.textSecondary },
  primary: { bg: colors.primarySoft, fg: colors.primaryDark },
  secondary: { bg: colors.secondarySoft, fg: colors.secondaryDark },
  accent: { bg: colors.accentSoft, fg: colors.accent },
  success: { bg: colors.successSoft, fg: colors.success },
  warning: { bg: colors.warningSoft, fg: colors.warning },
  danger: { bg: colors.dangerSoft, fg: colors.danger },
};

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Solid fill instead of a soft tint — used for the active tab indicator. */
  solid?: boolean;
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Badge({ label, tone = 'neutral', icon, solid = false, size = 'md', style, testID }: BadgeProps): React.ReactElement {
  const palette = TONES[tone];

  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xxs,
          alignSelf: 'flex-start',
          paddingHorizontal: size === 'sm' ? spacing.sm : spacing.md,
          paddingVertical: size === 'sm' ? 2 : spacing.xs,
          borderRadius: radii.pill,
          backgroundColor: solid ? palette.fg : palette.bg,
        },
        style,
      ]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={size === 'sm' ? 10 : sizes.iconXs}
          color={solid ? colors.textInverse : palette.fg}
        />
      ) : null}
      <Text
        variant={size === 'sm' ? 'captionSmall' : 'caption'}
        style={[typography.caption, { color: solid ? colors.textInverse : palette.fg }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

/** Numeric count bubble, e.g. unread notifications. */
export function CountBadge({ count, max = 99, style }: { count: number; max?: number; style?: StyleProp<ViewStyle> }): React.ReactElement | null {
  if (count <= 0) return null;
  const label = count > max ? `${max}+` : String(count);

  return (
    <View
      accessibilityLabel={`${count} unread`}
      style={[
        {
          minWidth: 18,
          height: 18,
          paddingHorizontal: 5,
          borderRadius: radii.pill,
          backgroundColor: colors.danger,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Text variant="captionSmall" style={{ color: colors.textInverse, fontSize: 10, lineHeight: 13, fontWeight: '700' }}>
        {label}
      </Text>
    </View>
  );
}

export default Badge;
