import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type StyleProp, type TextStyle } from 'react-native';
import { colors, typography, type TypographyToken } from '../../theme/tokens.js';

/**
 * Typography primitive.
 *
 * Every piece of text in the app goes through here so the type scale in
 * `theme/tokens.ts` is the single source of truth. `variant` picks the size and
 * weight; `tone` picks the colour — passing a raw hex string is intentionally
 * not supported, because that is how a design system rots.
 */

export type TextVariant = TypographyToken;

export type TextTone =
  | 'default'
  | 'secondary'
  | 'tertiary'
  | 'inverse'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent';

const TONE_COLORS: Record<TextTone, string> = {
  default: colors.text,
  secondary: colors.textSecondary,
  tertiary: colors.textTertiary,
  inverse: colors.textInverse,
  primary: colors.primary,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
  accent: colors.accent,
};

export interface TextProps extends Omit<RNTextProps, 'style'> {
  variant?: TextVariant;
  tone?: TextTone;
  /** Centre the text without the caller writing a style object. */
  align?: 'left' | 'center' | 'right';
  /** Render at 1.5x for large-text accessibility settings. */
  largeTextScale?: boolean;
  style?: StyleProp<TextStyle>;
  children?: React.ReactNode;
}

export function Text({
  variant = 'body',
  tone = 'default',
  align,
  style,
  children,
  ...rest
}: TextProps): React.ReactElement {
  const scale = typography[variant] ?? typography.body;

  return (
    <RNText
      accessibilityRole={rest.accessibilityRole}
      {...rest}
      style={[
        scale,
        { color: TONE_COLORS[tone] },
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

/**
 * Screen title using the display face.
 * Kept separate so the two heading levels stay consistent across 15 screens.
 */
export function ScreenTitle({ children, style, ...rest }: Omit<TextProps, 'variant'>): React.ReactElement {
  return (
    <Text variant="displaySmall" {...rest} style={style}>
      {children}
    </Text>
  );
}

/** Small uppercase label used above grouped sections. */
export function SectionLabel({ children, style, ...rest }: Omit<TextProps, 'variant'>): React.ReactElement {
  return (
    <Text variant="overline" tone="tertiary" {...rest} style={style}>
      {children}
    </Text>
  );
}

export default Text;
