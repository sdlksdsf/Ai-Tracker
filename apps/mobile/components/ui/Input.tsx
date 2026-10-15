import React, { forwardRef, useState } from 'react';
import {
  TextInput,
  View,
  Pressable,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing, typography } from '../../theme/tokens.js';
import { Text } from './Text.js';

/**
 * Text input.
 *
 * The error state is part of the component rather than something the caller
 * renders underneath, so a form field's border, message and accessibility state
 * can never disagree with each other.
 */

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  /** Field-level error, rendered below the input and announced to TalkBack. */
  error?: string | null;
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Trailing action, e.g. a barcode scanner button. */
  rightAccessory?: React.ReactNode;
  /** Password reveal toggle. */
  secureToggle?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  /** Applied to the `TextInput` itself, so it must be a *text* style. */
  inputStyle?: StyleProp<TextStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    error,
    hint,
    icon,
    rightAccessory,
    secureToggle = false,
    secureTextEntry,
    containerStyle,
    inputStyle,
    testID,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const isSecure = secureToggle ? !revealed : secureTextEntry;
  const borderColor = error ? colors.danger : focused ? colors.primary : colors.border;

  return (
    <View style={[{ gap: spacing.xs }, containerStyle]}>
      {label ? (
        <Text variant="caption" tone="secondary" testID={testID ? `${testID}-label` : undefined}>
          {label}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: sizes.inputHeight,
          paddingHorizontal: spacing.lg,
          borderRadius: radii.md,
          backgroundColor: colors.surface,
          borderWidth: sizes.borderWidthThick,
          borderColor,
        }}
      >
        {icon ? <Ionicons name={icon} size={sizes.iconMd} color={focused ? colors.primary : colors.textTertiary} /> : null}

        <TextInput
          ref={ref}
          testID={testID}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={isSecure}
          // RN's AccessibilityState has no `invalid` key, so an error is
          // announced through the label instead — a screen-reader user still
          // hears why the field was rejected.
          accessibilityLabel={error && label ? `${label}, error: ${error}` : label}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            typography.bodyLarge,
            {
              flex: 1,
              color: colors.text,
              paddingVertical: spacing.md,
              // Android adds its own vertical padding to TextInput.
              textAlignVertical: 'center',
            },
            inputStyle,
          ]}
          {...rest}
        />

        {secureToggle ? (
          <Pressable
            onPress={() => setRevealed((value) => !value)}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            testID={testID ? `${testID}-toggle` : undefined}
          >
            <Ionicons
              name={revealed ? 'eye-off-outline' : 'eye-outline'}
              size={sizes.iconMd}
              color={colors.textTertiary}
            />
          </Pressable>
        ) : null}

        {rightAccessory}
      </View>

      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <Ionicons name="alert-circle" size={sizes.iconXs} color={colors.danger} />
          <Text variant="caption" tone="danger" testID={testID ? `${testID}-error` : undefined}>
            {error}
          </Text>
        </View>
      ) : null}

      {!error && hint ? (
        <Text variant="captionSmall" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

/** A labelled, non-editable field that opens a picker on press. */
export function SelectField({
  label,
  value,
  placeholder = 'Select…',
  onPress,
  error,
  icon,
  testID,
}: {
  label?: string;
  value?: string | null;
  placeholder?: string;
  onPress: () => void;
  error?: string | null;
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
}): React.ReactElement {
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? (
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
      ) : null}
      <Pressable
        onPress={onPress}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${value ?? placeholder}` : value ?? placeholder}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            minHeight: sizes.inputHeight,
            paddingHorizontal: spacing.lg,
            borderRadius: radii.md,
            backgroundColor: colors.surface,
            borderWidth: sizes.borderWidthThick,
            borderColor: error ? colors.danger : colors.border,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        {icon ? <Ionicons name={icon} size={sizes.iconMd} color={colors.textTertiary} /> : null}
        <Text variant="bodyLarge" tone={value ? 'default' : 'tertiary'} style={{ flex: 1 }} numberOfLines={1}>
          {value ?? placeholder}
        </Text>
        <Ionicons name="chevron-down" size={sizes.iconMd} color={colors.textTertiary} />
      </Pressable>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** Stepper for numeric quantities ("2 pcs", "500 g"). */
export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 9999,
  step = 1,
  suffix,
  testID,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  testID?: string;
}): React.ReactElement {
  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  // Avoid 0.30000000000000004 leaking into the UI after repeated 0.1 steps.
  const round = (next: number): number => Math.round(next * 1000) / 1000;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.surface,
        borderRadius: radii.md,
        borderWidth: sizes.borderWidth,
        borderColor: colors.border,
        paddingHorizontal: spacing.xs,
        minHeight: sizes.buttonHeightSm,
        alignSelf: 'flex-start',
      }}
    >
      <Pressable
        onPress={() => onChange(round(clamp(value - step)))}
        disabled={value <= min}
        hitSlop={spacing.sm}
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${suffix ?? 'quantity'}`}
        testID={testID ? `${testID}-decrease` : undefined}
        style={({ pressed }) => [{
          width: 36,
          height: 36,
          borderRadius: radii.sm,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: value <= min ? 0.35 : pressed ? 0.7 : 1,
        }]}
      >
        <Ionicons name="remove" size={sizes.iconMd} color={colors.primary} />
      </Pressable>

      <Text variant="bodyMedium" style={{ minWidth: 56, textAlign: 'center' }} testID={testID ? `${testID}-value` : undefined}>
        {round(value)}
        {suffix ? ` ${suffix}` : ''}
      </Text>

      <Pressable
        onPress={() => onChange(round(clamp(value + step)))}
        disabled={value >= max}
        hitSlop={spacing.sm}
        accessibilityRole="button"
        accessibilityLabel={`Increase ${suffix ?? 'quantity'}`}
        testID={testID ? `${testID}-increase` : undefined}
        style={({ pressed }) => [{
          width: 36,
          height: 36,
          borderRadius: radii.sm,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: value >= max ? 0.35 : pressed ? 0.7 : 1,
        }]}
      >
        <Ionicons name="add" size={sizes.iconMd} color={colors.primary} />
      </Pressable>
    </View>
  );
}

export default Input;
