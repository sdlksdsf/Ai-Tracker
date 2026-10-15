import React from 'react';
import { Pressable, View } from 'react-native';
import { colors, radii, spacing } from '../../theme/tokens.js';
import { Text } from '../ui/Text.js';

/**
 * Bar chart.
 *
 * Pure `View` layout — no SVG needed for vertical bars, and Views give free
 * accessibility and touch targets. Used for the 7-day calorie comparison
 * (Screen 12) and the weekly waste-by-category breakdown (Screen 11).
 */

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
  /** Renders the bar hollow — used for the current, still-incomplete day. */
  muted?: boolean;
  /** Value shown above the bar instead of the raw number. */
  displayValue?: string;
  onPress?: () => void;
}

export interface BarChartProps {
  data: BarDatum[];
  height?: number;
  /** Draw a dashed line at this value, e.g. the daily calorie target. */
  referenceValue?: number;
  referenceLabel?: string;
  valueFormatter?: (value: number) => string;
  showValues?: boolean;
  gap?: number;
  testID?: string;
}

export function BarChart({
  data,
  height = 140,
  referenceValue,
  referenceLabel,
  valueFormatter = (value) => String(Math.round(value)),
  showValues = false,
  gap = spacing.sm,
  testID,
}: BarChartProps): React.ReactElement {
  const maxValue = Math.max(1, ...data.map((datum) => Math.max(0, datum.value)), referenceValue ?? 0);

  return (
    <View testID={testID} accessibilityLabel={describe(data, valueFormatter)} style={{ gap: spacing.sm }}>
      <View style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap }}>
        {data.map((datum) => {
          // Clamp so one outlier day does not flatten every other bar.
          const ratio = Math.min(1, Math.max(0, datum.value) / maxValue);
          const barHeight = Math.max(datum.value > 0 ? 4 : 0, ratio * height);
          const color = datum.color ?? colors.primary;

          const bar = (
            <View
              key={datum.label}
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'flex-end',
                height: '100%',
                gap: 4,
              }}
            >
              {showValues ? (
                <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
                  {datum.displayValue ?? valueFormatter(datum.value)}
                </Text>
              ) : null}
              <View
                style={{
                  width: '100%',
                  height: barHeight,
                  borderRadius: radii.xs,
                  backgroundColor: datum.muted ? 'transparent' : color,
                  borderWidth: datum.muted ? 1 : 0,
                  borderColor: datum.muted ? color : 'transparent',
                  borderStyle: 'dashed',
                  opacity: datum.muted ? 0.6 : 1,
                }}
              />
            </View>
          );

          return datum.onPress ? (
            <Pressable
              key={datum.label}
              onPress={datum.onPress}
              accessibilityRole="button"
              accessibilityLabel={`${datum.label}: ${valueFormatter(datum.value)}`}
              style={{ flex: 1, height: '100%' }}
            >
              {bar}
            </Pressable>
          ) : (
            <View key={datum.label} style={{ flex: 1, height: '100%' }} accessibilityLabel={`${datum.label}: ${valueFormatter(datum.value)}`}>
              {bar}
            </View>
          );
        })}

        {referenceValue !== undefined && referenceValue > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              // Position from the bottom, since bars grow upward.
              bottom: (Math.min(1, referenceValue / maxValue) * height) - 1,
              height: 1,
              borderTopWidth: 1,
              borderTopColor: colors.textTertiary,
              borderStyle: 'dashed',
              opacity: 0.7,
            }}
          />
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap }}>
        {data.map((datum) => (
          <Text key={datum.label} variant="captionSmall" tone="tertiary" align="center" style={{ flex: 1 }} numberOfLines={1}>
            {datum.label}
          </Text>
        ))}
      </View>

      {referenceValue !== undefined && referenceLabel ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 16, height: 1, borderTopWidth: 1, borderTopColor: colors.textTertiary, borderStyle: 'dashed' }} />
          <Text variant="captionSmall" tone="tertiary">
            {referenceLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Horizontal bars — the ranking layout for waste-by-category. */
export function HorizontalBarChart({
  data,
  valueFormatter = (value) => String(Math.round(value)),
  maxValue,
  testID,
}: {
  data: BarDatum[];
  valueFormatter?: (value: number) => string;
  maxValue?: number;
  testID?: string;
}): React.ReactElement {
  const peak = Math.max(1, maxValue ?? 0, ...data.map((datum) => Math.max(0, datum.value)));

  return (
    <View testID={testID} style={{ gap: spacing.md }}>
      {data.map((datum) => {
        const ratio = Math.min(1, Math.max(0, datum.value) / peak);
        return (
          <View key={datum.label} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                {datum.label}
              </Text>
              <Text variant="caption">{datum.displayValue ?? valueFormatter(datum.value)}</Text>
            </View>
            <View style={{ height: 8, borderRadius: radii.pill, backgroundColor: colors.divider, overflow: 'hidden' }}>
              <View
                style={{
                  width: `${Math.max(ratio * 100, datum.value > 0 ? 3 : 0)}%`,
                  height: '100%',
                  borderRadius: radii.pill,
                  backgroundColor: datum.color ?? colors.primary,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function describe(data: BarDatum[], format: (value: number) => string): string {
  if (!data.length) return 'No data';
  return data.map((datum) => `${datum.label}: ${format(datum.value)}`).join(', ');
}

export default BarChart;
