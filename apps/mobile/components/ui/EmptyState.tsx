import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, sizes, spacing } from '../../theme/tokens.js';
import { Text } from './Text.js';
import { Button } from './Button.js';

/**
 * Empty and error states.
 *
 * Every list screen needs one, and an empty screen with no explanation reads as
 * a bug. These always pair a concrete reason with the action that fixes it —
 * "No recipes yet" plus a Generate button, never just an icon.
 */

export interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  tone?: 'neutral' | 'primary' | 'warning' | 'danger';
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const TONE_COLORS = {
  neutral: colors.textTertiary,
  primary: colors.primary,
  warning: colors.warning,
  danger: colors.danger,
} as const;

const TONE_BACKGROUNDS = {
  neutral: colors.divider,
  primary: colors.primarySoft,
  warning: colors.warningSoft,
  danger: colors.dangerSoft,
} as const;

export function EmptyState({
  icon = 'leaf-outline',
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  tone = 'neutral',
  compact = false,
  style,
  testID,
}: EmptyStateProps): React.ReactElement {
  const badgeSize = compact ? 56 : 80;

  return (
    <View
      testID={testID}
      style={[
        {
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.md,
          paddingHorizontal: spacing.xxl,
          paddingVertical: compact ? spacing.xxl : spacing.huge,
        },
        style,
      ]}
    >
      <View
        style={{
          width: badgeSize,
          height: badgeSize,
          borderRadius: sizes.avatarLg,
          backgroundColor: TONE_BACKGROUNDS[tone],
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={compact ? sizes.iconLg : 40} color={TONE_COLORS[tone]} />
      </View>

      <Text variant={compact ? 'headingSmall' : 'headingMedium'} align="center">
        {title}
      </Text>

      {description ? (
        <Text variant="bodySmall" tone="secondary" align="center" style={{ maxWidth: 320 }}>
          {description}
        </Text>
      ) : null}

      {actionLabel && onAction ? (
        <View style={{ marginTop: spacing.sm, alignItems: 'center', gap: spacing.md }}>
          <Button label={actionLabel} onPress={onAction} variant={tone === 'danger' ? 'danger' : 'primary'} testID={testID ? `${testID}-action` : undefined} />
          {secondaryLabel && onSecondary ? (
            <Button label={secondaryLabel} onPress={onSecondary} variant="ghost" size="sm" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Error variant with a retry action, used by every failed query. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  testID,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  testID?: string;
}): React.ReactElement {
  return (
    <EmptyState
      icon="cloud-offline-outline"
      title={title}
      description={message ?? 'Check your connection and try again. Your data is safe.'}
      actionLabel={onRetry ? 'Try again' : undefined}
      onAction={onRetry}
      tone="danger"
      testID={testID}
    />
  );
}

export default EmptyState;
