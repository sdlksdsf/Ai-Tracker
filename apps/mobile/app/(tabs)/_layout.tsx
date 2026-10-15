import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { colors, elevation, sizes, spacing, zIndex } from '../../theme/tokens.js';
import { Text } from '../../components/ui/Text.js';
import { CountBadge } from '../../components/ui/Badge.js';
import { useUnreadCount } from '../../hooks/useApi.js';

/**
 * Five-tab bottom navigation (Section 6).
 *
 *   Home · Recipes · Scan · Plan · Profile
 *
 * The scan tab sits in the centre and is deliberately larger: it is the action
 * that starts the whole loop (scan → pantry → recipes → plan), so it gets
 * primary visual weight rather than being one of five equal icons.
 */

type TabIcon = keyof typeof Ionicons.glyphMap;

interface TabItem {
  name: string;
  label: string;
  icon: TabIcon;
  activeIcon: TabIcon;
}

export default function TabsLayout(): React.ReactElement {
  const { t } = useTranslation('tabs');
  const insets = useSafeAreaInsets();
  const { data: unread } = useUnreadCount();

  const tabs: TabItem[] = [
    { name: 'index', label: t('home'), icon: 'home-outline', activeIcon: 'home' },
    { name: 'recipes', label: t('recipes'), icon: 'book-outline', activeIcon: 'book' },
    { name: 'scan', label: t('scan'), icon: 'camera-outline', activeIcon: 'camera' },
    { name: 'plan', label: t('plan'), icon: 'calendar-outline', activeIcon: 'calendar' },
    { name: 'profile', label: t('profile'), icon: 'person-outline', activeIcon: 'person' },
  ];

  const barHeight = sizes.tabBarHeight + insets.bottom;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: barHeight,
          paddingTop: spacing.sm,
          paddingBottom: insets.bottom,
          backgroundColor: colors.surface,
          borderTopWidth: sizes.dividerHeight,
          borderTopColor: colors.divider,
          zIndex: zIndex.tabBar,
          ...elevation.level3,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarLabelStyle: { fontSize: 11, lineHeight: 14, fontFamily: 'Inter_500Medium' },
        tabBarItemStyle: { paddingVertical: 2 },
      }}
    >
      {tabs.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.label,
            tabBarIcon: ({ focused, color }) =>
              tab.name === 'scan' ? (
                <ScanTabIcon focused={focused} />
              ) : (
                <View style={{ alignItems: 'center', justifyContent: 'center', height: 30 }}>
                  <Ionicons name={focused ? tab.activeIcon : tab.icon} size={sizes.iconMd} color={color} />
                  {tab.name === 'profile' && unread?.unread ? (
                    <CountBadge count={unread.unread} style={{ position: 'absolute', top: -4, right: -8 }} />
                  ) : null}
                </View>
              ),
            tabBarLabel: tab.name === 'scan' ? () => null : undefined,
          }}
        />
      ))}
    </Tabs>
  );
}

/** Raised centre button for the scan action. */
function ScanTabIcon({ focused }: { focused: boolean }): React.ReactElement {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: sizes.avatarLg / 2,
          backgroundColor: focused ? colors.primaryDark : colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
          // Lift it above the bar so it reads as the primary action.
          marginTop: Platform.OS === 'ios' ? -18 : -14,
          borderWidth: 4,
          borderColor: colors.surface,
          ...elevation.level3,
        }}
      >
        <Ionicons name="scan" size={sizes.iconLg} color={colors.textInverse} />
      </View>
    </View>
  );
}

/** Re-exported so the Home screen can render a matching quick action. */
export function TabQuickAction({ label, onPress }: { label: string; onPress: () => void }): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          borderRadius: 12,
          backgroundColor: colors.surface,
          opacity: pressed ? 0.85 : 1,
          ...elevation.level1,
        },
      ]}
    >
      <Text variant="caption">{label}</Text>
    </Pressable>
  );
}
