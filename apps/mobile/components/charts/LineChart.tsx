import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { colors, spacing, typography } from '../../theme/tokens.js';
import { Text } from '../ui/Text.js';

/**
 * Line / area chart.
 *
 * Renders the cumulative savings curve (Screen 4) and the waste trend
 * (Screen 11). The path is built by hand from the data points so the component
 * stays readable and testable without a charting dependency.
 */

export interface LinePoint {
  label: string;
  value: number;
}

export interface LineChartProps {
  data: LinePoint[];
  height?: number;
  width?: number;
  color?: string;
  /** Fill the area under the line. */
  area?: boolean;
  /** Show a dot on the final point with its value. */
  highlightLast?: boolean;
  yFormatter?: (value: number) => string;
  /** Number of x-axis labels to render, so 90 days stays legible. */
  xLabelCount?: number;
  showGrid?: boolean;
  testID?: string;
}

export function LineChart({
  data,
  height = 160,
  width = 320,
  color = colors.primary,
  area = true,
  highlightLast = true,
  yFormatter = (value) => String(Math.round(value)),
  xLabelCount = 4,
  showGrid = true,
  testID,
}: LineChartProps): React.ReactElement {
  const padding = { top: 12, right: 12, bottom: 22, left: 34 };

  const geometry = useMemo(() => {
    const values = data.map((point) => point.value);
    const rawMin = values.length ? Math.min(...values) : 0;
    const rawMax = values.length ? Math.max(...values) : 0;

    // Pad the domain so the line does not touch the edges, and guarantee a
    // non-zero span for a flat series (otherwise every y maps to NaN).
    const span = rawMax - rawMin;
    const min = span === 0 ? Math.max(0, rawMin - 1) : rawMin - span * 0.08;
    const max = span === 0 ? rawMax + 1 : rawMax + span * 0.08;

    const innerWidth = Math.max(1, width - padding.left - padding.right);
    const innerHeight = Math.max(1, height - padding.top - padding.bottom);

    const xFor = (index: number): number =>
      data.length <= 1 ? padding.left + innerWidth / 2 : padding.left + (index / (data.length - 1)) * innerWidth;

    const yFor = (value: number): number => padding.top + innerHeight - ((value - min) / (max - min)) * innerHeight;

    const points = data.map((point, index) => ({ x: xFor(index), y: yFor(point.value), ...point }));

    const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    const areaPath = points.length
      ? `${linePath} L${points[points.length - 1]!.x.toFixed(2)},${(padding.top + innerHeight).toFixed(2)} L${points[0]!.x.toFixed(2)},${(padding.top + innerHeight).toFixed(2)} Z`
      : '';

    // Gridlines at four evenly spaced values.
    const gridValues = Array.from({ length: 4 }, (_, index) => min + ((max - min) * index) / 3);

    // Evenly spaced x labels, always including the first and last.
    const labelStep = Math.max(1, Math.ceil(data.length / Math.max(1, xLabelCount)));
    const xLabels = points.filter((_, index) => index % labelStep === 0 || index === points.length - 1);

    return { points, linePath, areaPath, gridValues, xLabels, yFor, min, max, innerHeight };
  }, [data, width, height, xLabelCount, padding.left, padding.right, padding.top, padding.bottom]);

  const gradientId = useMemo(() => `line-gradient-${Math.abs(color.split('').reduce((acc, char) => acc * 31 + char.charCodeAt(0), 7))}`, [color]);

  if (!data.length) {
    return (
      <View testID={testID} style={{ height, alignItems: 'center', justifyContent: 'center' }}>
        <Text variant="bodySmall" tone="tertiary">
          No data yet
        </Text>
      </View>
    );
  }

  return (
    <View testID={testID} accessibilityLabel={describe(data, yFormatter)}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0.28} />
            <Stop offset="1" stopColor={color} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>

        {showGrid
          ? geometry.gridValues.map((value, index) => {
              const y = geometry.yFor(value);
              return (
                <React.Fragment key={`grid-${index}`}>
                  <Line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke={colors.divider} strokeWidth={1} />
                  <SvgText x={padding.left - 6} y={y + 4} fontSize={10} fill={colors.textTertiary} textAnchor="end">
                    {yFormatter(value)}
                  </SvgText>
                </React.Fragment>
              );
            })
          : null}

        {area ? <Path d={geometry.areaPath} fill={`url(#${gradientId})`} /> : null}

        <Path d={geometry.linePath} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />

        {highlightLast && geometry.points.length ? (
          <Circle
            cx={geometry.points[geometry.points.length - 1]!.x}
            cy={geometry.points[geometry.points.length - 1]!.y}
            r={4.5}
            fill={colors.surface}
            stroke={color}
            strokeWidth={2.5}
          />
        ) : null}

        {geometry.xLabels.map((point) => (
          <SvgText
            key={`x-${point.label}-${point.x}`}
            x={point.x}
            y={height - 6}
            fontSize={10}
            fill={colors.textTertiary}
            textAnchor="middle"
          >
            {point.label}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}

/** Stat pair rendered above a chart: current value plus the delta vs. before. */
export function ChartHeader({
  value,
  label,
  delta,
  deltaSuffix = '%',
  invertDelta = false,
}: {
  value: string;
  label: string;
  delta?: number | null;
  deltaSuffix?: string;
  /** True when a decrease is good, e.g. waste going down. */
  invertDelta?: boolean;
}): React.ReactElement {
  const isPositive = (delta ?? 0) > 0;
  const goodDirection = invertDelta ? !isPositive : isPositive;
  const tone = delta === 0 || delta === null || delta === undefined ? 'tertiary' : goodDirection ? 'success' : 'danger';

  return (
    <View style={{ gap: 2 }}>
      <Text variant="stat">{value}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
        {delta !== null && delta !== undefined ? (
          <Text variant="caption" tone={tone} style={typography.caption}>
            {isPositive ? '▲' : '▼'} {Math.abs(Math.round(delta))}
            {deltaSuffix}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function describe(data: LinePoint[], format: (value: number) => string): string {
  if (!data.length) return 'No data';
  const first = data[0]!;
  const last = data[data.length - 1]!;
  const peak = Math.max(...data.map((point) => point.value));
  return `Trend from ${first.label} (${format(first.value)}) to ${last.label} (${format(last.value)}), peak ${format(peak)}.`;
}

export default LineChart;
