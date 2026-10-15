import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';

/**
 * Skeleton loading placeholders.
 *
 * A shimmer that matches the final layout beats a spinner: the user can see what
 * is coming and the screen does not jump when data arrives.
 */

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  circle?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Skeleton({ width, height = 16, radius = radii.sm, circle = false, style, testID }: SkeletonProps): React.ReactElement {
  const opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  const size = circle ? (typeof width === 'number' ? width : height) : undefined;

  return (
    <Animated.View
      testID={testID}
      accessibilityElementsHidden
      style={[
        {
          width: circle ? size : width,
          height: circle ? size : height,
          borderRadius: circle ? radii.pill : radius,
          backgroundColor: colors.skeleton,
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Placeholder shaped like a recipe card. */
export function RecipeCardSkeleton(): React.ReactElement {
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radii.md, overflow: 'hidden' }}>
      <Skeleton width="100%" height={sizes.cardImageHeight} radius={0} />
      <View style={{ padding: spacing.lg, gap: spacing.sm }}>
        <Skeleton width="75%" height={18} />
        <Skeleton width="45%" height={13} />
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
          <Skeleton width={64} height={22} radius={radii.pill} />
          <Skeleton width={56} height={22} radius={radii.pill} />
          <Skeleton width={70} height={22} radius={radii.pill} />
        </View>
      </View>
    </View>
  );
}

/** Placeholder shaped like a pantry/grocery row. */
export function ListRowSkeleton(): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm }}>
      <Skeleton circle width={sizes.thumbnailSm} height={sizes.thumbnailSm} />
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Skeleton width="55%" height={15} />
        <Skeleton width="30%" height={12} />
      </View>
      <Skeleton width={48} height={24} radius={radii.pill} />
    </View>
  );
}

/** A list of N row skeletons. */
export function SkeletonList({ count = 5, variant = 'row' }: { count?: number; variant?: 'row' | 'card' }): React.ReactElement {
  return (
    <View style={{ gap: spacing.md }}>
      {Array.from({ length: count }, (_, index) =>
        variant === 'card' ? <RecipeCardSkeleton key={index} /> : <ListRowSkeleton key={index} />,
      )}
    </View>
  );
}

export default Skeleton;
