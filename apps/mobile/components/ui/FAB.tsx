import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, elevation, motion, radii, sizes, spacing, zIndex } from '../../theme/tokens.js';
import { Text } from './Text.js';

/**
 * Floating action button (Section 6 — Screen 9).
 *
 * The primary "add" action on the pantry and grocery screens. Sits above the tab
 * bar and animates in with a spring so it does not pop during a screen transition.
 */

export interface FABProps {
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  label?: string;
  /** Extended variant shows the label next to the icon. */
  extended?: boolean;
  tone?: string;
  disabled?: boolean;
  /** Offset from the bottom edge, used when a footer action is already present. */
  bottomOffset?: number;
  accessibilityLabel?: string;
  testID?: string;
}

export function FAB({
  icon = 'add',
  onPress,
  label,
  extended = false,
  tone = colors.primary,
  disabled = false,
  bottomOffset = 0,
  accessibilityLabel,
  testID,
}: FABProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const scale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: disabled ? 0 : 1,
      useNativeDriver: true,
      ...motion.easing.spring,
    }).start();
  }, [scale, disabled]);

  const showLabel = extended && Boolean(label);
  const size = showLabel ? undefined : 60;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        right: spacing.lg,
        bottom: insets.bottom + sizes.tabBarHeight + spacing.lg + bottomOffset,
        zIndex: zIndex.fab,
        transform: [{ scale }],
        opacity: scale,
      }}
    >
      <Pressable
        onPress={onPress}
        disabled={disabled}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label ?? icon}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.sm,
            width: size,
            height: 56,
            paddingHorizontal: showLabel ? spacing.xl : undefined,
            borderRadius: showLabel ? radii.pill : radii.pill,
            backgroundColor: tone,
            opacity: disabled ? 0 : pressed ? 0.88 : 1,
            ...elevation.level3,
          },
        ]}
      >
        <Ionicons name={icon} size={sizes.iconLg} color={colors.textInverse} />
        {showLabel ? (
          <Text variant="bodyMedium" style={{ color: colors.textInverse }}>
            {label}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Speed-dial variant: a stack of labelled actions above the FAB.
 *
 * Used on the pantry screen where "add" branches into manual / scan / barcode.
 */
export interface SpeedDialAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  tone?: string;
}

export function SpeedDial({
  actions,
  open,
  onToggle,
  bottomOffset = 0,
  testID,
}: {
  actions: SpeedDialAction[];
  open: boolean;
  onToggle: () => void;
  bottomOffset?: number;
  testID?: string;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
  const base = insets.bottom + sizes.tabBarHeight + spacing.lg + bottomOffset;

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', right: spacing.lg, bottom: base, zIndex: zIndex.fab, alignItems: 'flex-end', gap: spacing.md }}>
      {open
        ? actions.map((action, index) => (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              testID={testID ? `${testID}-${action.key}` : undefined}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  // Stagger upward from the FAB.
                  marginBottom: (actions.length - index) * 4,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <View
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.xs,
                  borderRadius: radii.sm,
                  backgroundColor: colors.text,
                }}
              >
                <Text variant="caption" style={{ color: colors.textInverse }}>
                  {action.label}
                </Text>
              </View>
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: radii.pill,
                  backgroundColor: action.tone ?? colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: sizes.borderWidth,
                  borderColor: colors.border,
                  ...elevation.level2,
                }}
              >
                <Ionicons name={action.icon} size={sizes.iconMd} color={action.tone ? colors.textInverse : colors.primary} />
              </View>
            </Pressable>
          ))
        : null}

      <FAB icon={open ? 'close' : 'add'} onPress={onToggle} label={undefined} testID={testID ? `${testID}-toggle` : undefined} />
    </View>
  );
}

export default FAB;
