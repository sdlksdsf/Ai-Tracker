import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';
import { colors, typography } from '../../theme/tokens.js';
import { Text } from '../ui/Text.js';

/**
 * Donut chart.
 *
 * Built on `react-native-svg` rather than Victory Native XL: Victory pulls in
 * `@shopify/react-native-skia`, a large native dependency that complicates EAS
 * builds for a chart this simple. Strokes on a circle give the same result with
 * no extra native module.
 *
 * Used for the daily calorie ring (Screen 2) and the macro split (Screen 12).
 */

export interface DonutSegment {
  /** Display label, used in the legend. */
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  /** Ring thickness as a fraction of the radius (0..1). */
  thickness?: number;
  /** Big number rendered in the middle. */
  centerValue?: string;
  centerLabel?: string;
  /** Render the legend underneath. */
  showLegend?: boolean;
  testID?: string;
}

export function DonutChart({
  segments,
  size = 160,
  thickness = 0.22,
  centerValue,
  centerLabel,
  showLegend = true,
  testID,
}: DonutChartProps): React.ReactElement {
  const stroke = size * thickness;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // A zero total would divide by zero and render NaN dash arrays.
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);

  // Each arc is a full circle with a dash pattern that reveals only its slice,
  // rotated by the accumulated angle of the slices before it.
  let accumulated = 0;
  const arcs = total > 0
    ? segments
        .filter((segment) => segment.value > 0)
        .map((segment) => {
          const fraction = segment.value / total;
          const arc = {
            key: segment.label,
            color: segment.color,
            dash: fraction * circumference,
            gap: circumference - fraction * circumference,
            // -90° so the first slice starts at 12 o'clock.
            rotation: (accumulated * 360) / 1 - 90,
            fraction,
          };
          accumulated += fraction;
          return arc;
        })
    : [];

  return (
    <View testID={testID} accessibilityLabel={describeSegments(segments, total)} style={{ alignItems: 'center', gap: 12 }}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <G rotation={0} originX={center} originY={center}>
            {/* Track */}
            <Circle
              cx={center}
              cy={center}
              r={radius}
              stroke={colors.divider}
              strokeWidth={stroke}
              fill="none"
            />
            {arcs.map((arc) => (
              <Circle
                key={arc.key}
                cx={center}
                cy={center}
                r={radius}
                stroke={arc.color}
                strokeWidth={stroke}
                fill="none"
                strokeDasharray={`${arc.dash} ${arc.gap}`}
                strokeLinecap="butt"
                rotation={arc.rotation}
                originX={center}
                originY={center}
              />
            ))}
          </G>
        </Svg>

        {centerValue ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text variant="stat" style={{ fontSize: size * 0.17 }}>
              {centerValue}
            </Text>
            {centerLabel ? (
              <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
                {centerLabel}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {showLegend && segments.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12 }}>
          {segments.map((segment) => (
            <View key={segment.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: segment.color }} />
              <Text variant="captionSmall" tone="secondary">
                {segment.label}
              </Text>
              <Text variant="captionSmall" style={[typography.caption, { color: colors.text }]}>
                {Math.round(segment.value)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Calorie ring variant: one arc against a target rather than a multi-segment
 * breakdown. Colour shifts to red when the target is exceeded.
 */
export function CalorieRing({
  consumed,
  target,
  size = 168,
  testID,
}: {
  consumed: number;
  target: number;
  size?: number;
  testID?: string;
}): React.ReactElement {
  const ratio = target > 0 ? consumed / target : 0;
  const over = ratio > 1;
  const remaining = Math.max(0, Math.round(target - consumed));

  return (
    <DonutChart
      size={size}
      thickness={0.18}
      testID={testID}
      segments={[
        { label: 'Eaten', value: Math.max(0, consumed), color: over ? colors.danger : colors.primary },
        { label: 'Remaining', value: Math.max(0, target - consumed), color: colors.divider },
      ]}
      centerValue={String(Math.round(consumed))}
      centerLabel={over ? `${Math.round(consumed - target)} over` : `${remaining} left`}
      showLegend={false}
    />
  );
}

function describeSegments(segments: DonutSegment[], total: number): string {
  if (total <= 0) return 'No data';
  return segments
    .map((segment) => `${segment.label}: ${Math.round(segment.value)} (${Math.round((segment.value / total) * 100)}%)`)
    .join(', ');
}

export default DonutChart;
