import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Card } from './ui/Card.js';
import { Text } from './ui/Text.js';

/**
 * Stat tile (Section 6, Screens 2 and 12).
 *
 * The Home screen's four impact numbers — money saved, waste prevented, CO₂ and
 * streak — all render through this so their typography and spacing match exactly.
 */

export interface StatCardProps {
  label: string;
  value: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Accent colour for the icon chip. */
  tone?: string;
  softTone?: string;
  /** Delta vs. the previous period; negative values are not automatically "bad". */
  delta?: string | null;
  deltaPositive?: boolean;
  sublabel?: string;
  onPress?: () => void;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function StatCard({
  label,
  value,
  icon,
  tone = colors.primary,
  softTone = colors.primarySoft,
  delta,
  deltaPositive = true,
  sublabel,
  onPress,
  compact = false,
  style,
  testID,
}: StatCardProps): React.ReactElement {
  return (
    <Card onPress={onPress} padding={compact ? 'md' : 'lg'} style={[{ flex: 1 }, style]} testID={testID} accessibilityLabel={`${label}: ${value}`}>
      <View style={{ gap: compact ? 4 : spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
          <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
            {label}
          </Text>
          {icon ? (
            <View
              style={{
                width: compact ? 26 : 32,
                height: compact ? 26 : 32,
                borderRadius: radii.sm,
                backgroundColor: softTone,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name={icon} size={compact ? sizes.iconXs : sizes.iconSm} color={tone} />
            </View>
          ) : null}
        </View>

        <Text variant={compact ? 'statSmall' : 'stat'} numberOfLines={1} testID={testID ? `${testID}-value` : undefined}>
          {value}
        </Text>

        {delta ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Ionicons
              name={deltaPositive ? 'trending-up' : 'trending-down'}
              size={sizes.iconXs}
              color={deltaPositive ? colors.success : colors.danger}
            />
            <Text variant="captionSmall" tone={deltaPositive ? 'success' : 'danger'}>
              {delta}
            </Text>
          </View>
        ) : null}

        {sublabel ? (
          <Text variant="captionSmall" tone="tertiary" numberOfLines={2}>
            {sublabel}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

/** Two-up grid of stat tiles. */
export function StatGrid({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.ReactElement {
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginHorizontal: -spacing.xs }, style]}>
      {children}
    </View>
  );
}

export default StatCard;
