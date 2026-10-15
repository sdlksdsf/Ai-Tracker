import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, elevation, motion, radii, sizes, spacing, zIndex } from '../../theme/tokens.js';
import { Text } from './Text.js';

/**
 * Bottom sheet (Section 6 — radius 24, drag handle, swipe-to-dismiss).
 *
 * Built on `Modal` + `Animated` rather than a gesture library so it works on all
 * three platforms without a native dependency. The drag handle and the backdrop
 * both dismiss, and a downward flick past 40% of the sheet height dismisses too.
 */

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  /** Content pinned below the scroll area — usually the primary action. */
  footer?: React.ReactNode;
  /** Cap the sheet height as a fraction of the screen (0..1). */
  maxHeightRatio?: number;
  /** Allow dismissal by swiping down. */
  dismissible?: boolean;
  scrollable?: boolean;
  testID?: string;
}

export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxHeightRatio = 0.88,
  dismissible = true,
  scrollable = true,
  testID,
}: SheetProps): React.ReactElement {
  const screenHeight = Dimensions.get('window').height;
  const translateY = useRef(new Animated.Value(screenHeight)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.parallel([
      Animated.timing(translateY, {
        toValue: visible ? 0 : screenHeight,
        duration: visible ? motion.normal : motion.fast,
        easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: visible ? 1 : 0,
        duration: motion.normal,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
  }, [visible, screenHeight, translateY, backdropOpacity]);

  const panResponder = useMemo(() => {
    if (!dismissible) return null;

    let startY = 0;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Only claim the gesture once it is clearly a downward drag, so an inner
      // ScrollView keeps working.
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        startY = 0;
      },
      onPanResponderMove: (_event, gesture) => {
        const next = Math.max(0, startY + gesture.dy);
        translateY.setValue(next);
        backdropOpacity.setValue(Math.max(0, 1 - next / screenHeight));
      },
      onPanResponderRelease: (_event, gesture) => {
        // Flick or dragged past 40% → dismiss; otherwise snap back.
        const shouldDismiss = gesture.dy > screenHeight * 0.4 || gesture.vy > 0.8;
        Animated.timing(translateY, {
          toValue: shouldDismiss ? screenHeight : 0,
          duration: motion.fast,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
        Animated.timing(backdropOpacity, {
          toValue: shouldDismiss ? 0 : 1,
          duration: motion.fast,
          useNativeDriver: true,
        }).start();
        if (shouldDismiss) onClose();
      },
      onPanResponderTerminate: () => {
        Animated.timing(translateY, { toValue: 0, duration: motion.fast, useNativeDriver: true }).start();
        Animated.timing(backdropOpacity, { toValue: 1, duration: motion.fast, useNativeDriver: true }).start();
      },
    });
  }, [dismissible, screenHeight, translateY, backdropOpacity, onClose]);

  const sheetStyle: StyleProp<ViewStyle> = {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    maxHeight: screenHeight * maxHeightRatio,
    zIndex: zIndex.sheet,
    ...elevation.level4,
  };

  const body = (
    <>
      <View style={{ alignItems: 'center', paddingTop: spacing.md, paddingBottom: spacing.xs }} {...(panResponder?.panHandlers ?? {})}>
        {/* Drag handle */}
        <View style={{ width: 40, height: 4, borderRadius: radii.pill, backgroundColor: colors.borderStrong }} />
      </View>

      {title ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.md,
            gap: spacing.md,
          }}
          {...(panResponder?.panHandlers ?? {})}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headingMedium">{title}</Text>
            {subtitle ? (
              <Text variant="bodySmall" tone="secondary">
                {subtitle}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID={testID ? `${testID}-close` : undefined}
            style={({ pressed }) => [{
              width: 32,
              height: 32,
              borderRadius: radii.pill,
              backgroundColor: colors.divider,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            }]}
          >
            <Ionicons name="close" size={sizes.iconSm} color={colors.textSecondary} />
          </Pressable>
        </View>
      ) : null}

      {scrollable ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md }}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md }}>{children}</View>
      )}

      {footer ? (
        <View
          style={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            paddingBottom: spacing.lg,
            borderTopWidth: sizes.dividerHeight,
            borderTopColor: colors.divider,
            backgroundColor: colors.surface,
          }}
        >
          {footer}
        </View>
      ) : null}
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismissible ? onClose : () => undefined} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.overlay, opacity: backdropOpacity, zIndex: zIndex.overlay }}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={dismissible ? onClose : undefined}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            testID={testID ? `${testID}-backdrop` : undefined}
          />
        </Animated.View>

        <Animated.View
          testID={testID}
          accessibilityViewIsModal
          style={[sheetStyle, { position: 'absolute', left: 0, right: 0, bottom: 0, transform: [{ translateY }] }]}
        >
          {body}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * Single-choice list inside a sheet — the picker used for category, location,
 * unit, meal type and every other enum in the app.
 */
export interface SheetOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
}

export function OptionSheet<T extends string>({
  visible,
  onClose,
  onSelect,
  options,
  title,
  selected,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (value: T) => void;
  options: Array<SheetOption<T>>;
  title?: string;
  selected?: T | null;
  testID?: string;
}): React.ReactElement {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} testID={testID}>
      <View style={{ gap: spacing.xs }}>
        {options.map((option) => {
          const isSelected = option.value === selected;
          return (
            <Pressable
              key={option.value}
              disabled={option.disabled}
              testID={testID ? `${testID}-${option.value}` : undefined}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: isSelected, disabled: Boolean(option.disabled) }}
              onPress={() => {
                onSelect(option.value);
                onClose();
              }}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.lg,
                  borderRadius: radii.md,
                  backgroundColor: isSelected ? colors.primarySoft : pressed ? colors.surfaceAlt : 'transparent',
                  opacity: option.disabled ? 0.45 : 1,
                },
              ]}
            >
              {option.icon ? (
                <Ionicons name={option.icon} size={sizes.iconMd} color={isSelected ? colors.primary : colors.textSecondary} />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium" tone={isSelected ? 'primary' : 'default'}>
                  {option.label}
                </Text>
                {option.description ? (
                  <Text variant="captionSmall" tone="tertiary">
                    {option.description}
                  </Text>
                ) : null}
              </View>
              {isSelected ? <Ionicons name="checkmark-circle" size={sizes.iconMd} color={colors.primary} /> : null}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

export default Sheet;
