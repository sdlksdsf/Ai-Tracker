import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, motion, radii, sizes, spacing, zIndex } from '../../theme/tokens.js';
import { Text } from './Text.js';
import { useUiStore, type Toast as ToastModel, type ToastTone } from '../../stores/ui.store.js';

/**
 * Toast host.
 *
 * Mounted once in the root layout, above the navigator, so any screen — and any
 * mutation callback with no component in scope — can raise a message through the
 * UI store. Toasts stack from the bottom (above the tab bar) and animate in.
 */

const TONE_STYLES: Record<ToastTone, { bg: string; fg: string; icon: keyof typeof Ionicons.glyphMap }> = {
  success: { bg: colors.success, fg: colors.textInverse, icon: 'checkmark-circle' },
  error: { bg: colors.danger, fg: colors.textInverse, icon: 'alert-circle' },
  warning: { bg: colors.warning, fg: colors.textInverse, icon: 'warning' },
  info: { bg: colors.text, fg: colors.textInverse, icon: 'information-circle' },
};

function ToastRow({ toast }: { toast: ToastModel }): React.ReactElement {
  const dismiss = useUiStore((state) => state.dismissToast);
  const translateY = useRef(new Animated.Value(24)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const palette = TONE_STYLES[toast.tone];

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, ...motion.easing.spring }),
      Animated.timing(opacity, { toValue: 1, duration: motion.fast, useNativeDriver: true }),
    ]).start();
  }, [translateY, opacity]);

  return (
    <Animated.View
      testID={`toast-${toast.tone}`}
      style={{ opacity, transform: [{ translateY }] }}
    >
      <Pressable
        onPress={() => dismiss(toast.id)}
        accessibilityRole="alert"
        accessibilityLabel={toast.message}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.lg,
            borderRadius: radii.md,
            backgroundColor: palette.bg,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <Ionicons name={palette.icon} size={sizes.iconMd} color={palette.fg} />

        <View style={{ flex: 1 }}>
          <Text variant="bodySmall" style={{ color: palette.fg }} numberOfLines={3}>
            {toast.message}
          </Text>
        </View>

        {toast.action ? (
          <Pressable
            onPress={() => {
              toast.action?.onPress();
              dismiss(toast.id);
            }}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel={toast.action.label}
          >
            <Text variant="caption" style={{ color: palette.fg, textDecorationLine: 'underline' }}>
              {toast.action.label}
            </Text>
          </Pressable>
        ) : (
          <Ionicons name="close" size={sizes.iconSm} color={palette.fg} />
        )}
      </Pressable>
    </Animated.View>
  );
}

export function ToastHost(): React.ReactElement | null {
  const toasts = useUiStore((state) => state.toasts);
  const insets = useSafeAreaInsets();

  if (!toasts.length) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: spacing.lg,
        right: spacing.lg,
        // Sit above the tab bar, not underneath it.
        bottom: insets.bottom + sizes.tabBarHeight + spacing.md,
        gap: spacing.sm,
        zIndex: zIndex.toast,
      }}
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </View>
  );
}

export default ToastHost;
