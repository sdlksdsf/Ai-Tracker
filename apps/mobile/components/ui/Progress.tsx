import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radii, sizes } from '../../theme/tokens.js';
import { Text } from './Text.js';

/**
 * Progress indicators.
 *
 * `ProgressBar` animates width changes so a nutrition ring filling from 40% to
 * 85% reads as motion rather than a jump. `ProgressRing` is the SVG-free
 * circular variant used where a ring is wanted but `react-native-svg` is not
 * already mounted.
 */

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  color?: string;
  trackColor?: string;
  height?: number;
  radius?: number;
  animated?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

export function ProgressBar({
  value,
  color = colors.primary,
  trackColor = colors.divider,
  height = sizes.progressHeight,
  radius = radii.pill,
  animated = true,
  style,
  accessibilityLabel,
  testID,
}: ProgressBarProps): React.ReactElement {
  // Clamp: an over-target day would otherwise render past the track and clip.
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const progress = useRef(new Animated.Value(clamped)).current;

  useEffect(() => {
    if (!animated) {
      progress.setValue(clamped);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: clamped,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // width is not a native-driver property
    });
    animation.start();
    return () => animation.stop();
  }, [clamped, animated, progress]);

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'], extrapolate: 'clamp' });

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[{ height, borderRadius: radius, backgroundColor: trackColor, overflow: 'hidden' }, style]}
    >
      <Animated.View style={{ width, height: '100%', borderRadius: radius, backgroundColor: color }} />
    </View>
  );
}

/** Labelled progress row: "Protein 62/120 g" with a bar underneath. */
export function LabeledProgress({
  label,
  value,
  max,
  unit = 'g',
  color = colors.primary,
  testID,
}: {
  label: string;
  value: number;
  max: number;
  unit?: string;
  color?: string;
  testID?: string;
}): React.ReactElement {
  const ratio = max > 0 ? value / max : 0;
  const over = ratio > 1.05;

  return (
    <View style={{ gap: 4 }} testID={testID}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
        <Text variant="caption" tone={over ? 'danger' : 'default'}>
          {Math.round(value)}/{Math.round(max)} {unit}
        </Text>
      </View>
      <ProgressBar value={ratio} color={over ? colors.danger : color} height={sizes.progressHeightSm} />
    </View>
  );
}

/**
 * Segmented bar showing how a day's calories split across macros.
 *
 * One view rather than three bars, so the proportions are directly comparable.
 */
export function MacroBar({
  protein,
  carbs,
  fat,
  height = 10,
  testID,
}: {
  protein: number;
  carbs: number;
  fat: number;
  height?: number;
  testID?: string;
}): React.ReactElement {
  // Calories per gram, so the segments are comparable in energy rather than mass.
  const proteinKcal = Math.max(0, protein) * 4;
  const carbsKcal = Math.max(0, carbs) * 4;
  const fatKcal = Math.max(0, fat) * 9;
  const total = proteinKcal + carbsKcal + fatKcal;

  const segments = total > 0
    ? [
        { key: 'protein', flex: proteinKcal / total, color: colors.primary },
        { key: 'carbs', flex: carbsKcal / total, color: colors.accent },
        { key: 'fat', flex: fatKcal / total, color: colors.secondary },
      ]
    : [{ key: 'empty', flex: 1, color: colors.divider }];

  return (
    <View
      testID={testID}
      accessibilityLabel={`Macros: ${Math.round(protein)}g protein, ${Math.round(carbs)}g carbs, ${Math.round(fat)}g fat`}
      style={{ flexDirection: 'row', height, borderRadius: radii.pill, overflow: 'hidden', backgroundColor: colors.divider }}
    >
      {segments.map((segment) => (
        <View key={segment.key} style={{ flex: segment.flex, backgroundColor: segment.color }} />
      ))}
    </View>
  );
}

export default ProgressBar;
