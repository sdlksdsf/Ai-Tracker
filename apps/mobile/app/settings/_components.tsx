import React from 'react';
import { Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, sizes, spacing } from '../../theme/tokens.js';
import { Text } from '../../components/ui/Text.js';

/**
 * Settings row primitives.
 *
 * Extracted so every settings screen renders identical rows — a switch row that
 * is 4pt taller on one screen is the kind of inconsistency nobody notices until
 * the whole section looks untidy.
 */

export function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="overline" tone="tertiary" style={{ paddingHorizontal: spacing.xs }}>
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

export function SwitchRow({
  icon,
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
  last = false,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  last?: boolean;
  testID?: string;
}): React.ReactElement {
  return (
    <View testID={testID}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          minHeight: 56,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Ionicons name={icon} size={sizes.iconMd} color={colors.textSecondary} />

        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyMedium">{label}</Text>
          {hint ? (
            <Text variant="captionSmall" tone="tertiary" numberOfLines={2}>
              {hint}
            </Text>
          ) : null}
        </View>

        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ false: colors.borderStrong, true: colors.primaryLight }}
          thumbColor={colors.surface}
          ios_backgroundColor={colors.borderStrong}
          accessibilityLabel={label}
          testID={testID ? `${testID}-switch` : undefined}
        />
      </View>

      {last ? null : <View style={{ height: sizes.dividerHeight, backgroundColor: colors.divider, marginLeft: 56 }} />}
    </View>
  );
}

/** Row that opens a time picker — used for the three meal reminder times. */
export function TimeRow({
  icon,
  label,
  value,
  onPress,
  last = false,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress: () => void;
  last?: boolean;
  testID?: string;
}): React.ReactElement {
  return (
    <View testID={testID}>
      <View
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}`}
        style={{ minHeight: 56, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
      >
        <Ionicons name={icon} size={sizes.iconMd} color={colors.textSecondary} />
        <Text variant="bodyMedium" style={{ flex: 1 }}>
          {label}
        </Text>
        <Text variant="bodyMedium" tone="primary">
          {value}
        </Text>
        <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
      </View>
      {last ? null : <View style={{ height: sizes.dividerHeight, backgroundColor: colors.divider, marginLeft: 56 }} />}
    </View>
  );
}
