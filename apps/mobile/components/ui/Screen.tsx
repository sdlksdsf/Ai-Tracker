import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, maxContentWidth, sizes, spacing, zIndex } from '../../theme/tokens.js';
import { Text } from './Text.js';
import { IconButton } from './Button.js';

/**
 * Screen scaffold.
 *
 * Handles the safe area, the background colour, the optional header and the
 * tablet max-width, so a screen file contains only its own content. Every screen
 * in the app renders inside one of these.
 */

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  /** Show a back chevron. */
  back?: boolean;
  onBack?: () => void;
  right?: React.ReactNode;
  /** Large display title that collapses on scroll. */
  large?: boolean;
}

export interface ScreenProps {
  children?: React.ReactNode;
  header?: ScreenHeaderProps | null;
  /** Wrap content in a ScrollView (default true). */
  scrollable?: boolean;
  scrollProps?: Omit<React.ComponentProps<typeof ScrollView>, 'contentContainerStyle'>;
  padding?: boolean;
  /** Keyboard-aware padding for form screens. */
  keyboardAvoiding?: boolean;
  backgroundColor?: string;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Rendered above the tab bar — usually a primary action. */
  footer?: React.ReactNode;
  testID?: string;
}

export function Screen({
  children,
  header,
  scrollable = true,
  scrollProps,
  padding = true,
  keyboardAvoiding = false,
  backgroundColor = colors.background,
  style,
  contentStyle,
  footer,
  testID,
}: ScreenProps): React.ReactElement {
  const insets = useSafeAreaInsets();

  const body = (
    <View style={[{ flex: 1, backgroundColor }, style]} testID={testID}>
      {header ? <ScreenHeader {...header} /> : null}

      {scrollable ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            {
              paddingHorizontal: padding ? spacing.lg : 0,
              paddingTop: padding ? spacing.md : 0,
              // Leave room for the tab bar and any footer action.
              paddingBottom: padding ? insets.bottom + spacing.huge + (footer ? 72 : 0) : insets.bottom,
              gap: spacing.lg,
              alignSelf: 'center',
              width: '100%',
              maxWidth: maxContentWidth,
            },
            contentStyle,
          ]}
          {...scrollProps}
        >
          {children}
        </ScrollView>
      ) : (
        <View
          style={[
            {
              flex: 1,
              paddingHorizontal: padding ? spacing.lg : 0,
              paddingBottom: insets.bottom,
              alignSelf: 'center',
              width: '100%',
              maxWidth: maxContentWidth,
            },
            contentStyle,
          ]}
        >
          {children}
        </View>
      )}

      {footer ? (
        <View
          style={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            paddingBottom: insets.bottom + spacing.md,
            backgroundColor: colors.surface,
            borderTopWidth: sizes.dividerHeight,
            borderTopColor: colors.divider,
            zIndex: zIndex.sticky,
          }}
        >
          <View style={{ alignSelf: 'center', width: '100%', maxWidth: maxContentWidth }}>{footer}</View>
        </View>
      ) : null}
    </View>
  );

  if (!keyboardAvoiding) return <SafeAreaView style={{ flex: 1, backgroundColor }} edges={['top']}>{body}</SafeAreaView>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor }} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  back = false,
  onBack,
  right,
  large = false,
}: ScreenHeaderProps): React.ReactElement {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        paddingHorizontal: large ? spacing.lg : spacing.sm,
        paddingTop: large ? spacing.md : spacing.xs,
        paddingBottom: large ? spacing.md : spacing.xs,
        backgroundColor: colors.background,
        zIndex: zIndex.header,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: large ? 'flex-end' : 'center',
          minHeight: large ? undefined : sizes.headerHeight,
          gap: spacing.xs,
        }}
      >
        {back ? (
          <IconButton icon="chevron-back" onPress={onBack} accessibilityLabel="Go back" testID="header-back" />
        ) : null}

        <View style={{ flex: 1, paddingHorizontal: back || right ? spacing.xs : spacing.lg }}>
          <Text variant={large ? 'displaySmall' : 'headingMedium'} numberOfLines={large ? 2 : 1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {right ? <View style={{ paddingRight: spacing.sm }}>{right}</View> : null}
      </View>
      <View style={{ height: insets.top > 0 ? 0 : undefined }} />
    </View>
  );
}

/** Centred column that caps width on tablets. */
export function Centered({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.ReactElement {
  return (
    <View style={[{ alignSelf: 'center', width: '100%', maxWidth: maxContentWidth }, style]}>{children}</View>
  );
}

/** Horizontal divider with an optional centred label. */
export function Divider({ label }: { label?: string }): React.ReactElement {
  if (!label) {
    return <View style={{ height: sizes.dividerHeight, backgroundColor: colors.divider }} />;
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
      <View style={{ flex: 1, height: sizes.dividerHeight, backgroundColor: colors.divider }} />
      <Text variant="captionSmall" tone="tertiary">
        {label}
      </Text>
      <View style={{ flex: 1, height: sizes.dividerHeight, backgroundColor: colors.divider }} />
    </View>
  );
}

/** Section heading with an optional trailing action. */
export function SectionHeader({
  title,
  action,
  onAction,
  style,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, style]}>
      <Text variant="headingSmall">{title}</Text>
      {action && onAction ? (
        <IconButton icon="chevron-forward" onPress={onAction} accessibilityLabel={action} />
      ) : null}
    </View>
  );
}

export default Screen;
