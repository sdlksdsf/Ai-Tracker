import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { spacing } from '../../theme/tokens.js';
import { Text } from '../../components/ui/Text.js';
import { Button } from '../../components/ui/Button.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { Screen } from '../../components/ui/Screen.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { useActiveGroceryList } from '../../hooks/useApi.js';

/**
 * Redirector for "open my grocery list" links.
 *
 * The Plan tab and Home screen both want to reach the current list without
 * knowing its id, so this resolves the active list and forwards. Rendering a real
 * empty state (rather than a blank screen or an infinite spinner) matters because
 * a brand-new user hits this path from the meal-plan grocery preview.
 */
export default function LatestGroceryList(): React.ReactElement {
  const router = useRouter();
  const { data: list, isLoading } = useActiveGroceryList();

  useEffect(() => {
    if (list?.id) router.replace(`/grocery/${list.id}`);
  }, [list?.id, router]);

  if (isLoading) {
    return (
      <Screen header={{ title: 'Grocery list', back: true, onBack: () => router.back() }}>
        <SkeletonList count={5} />
      </Screen>
    );
  }

  if (!list) {
    return (
      <Screen header={{ title: 'Grocery list', back: true, onBack: () => router.back() }}>
        <View style={{ gap: spacing.lg }}>
          <EmptyState
            icon="cart-outline"
            tone="primary"
            title="No active shopping list"
            description="Build one from your meal plan, or start a list from scratch."
            actionLabel="Plan my week"
            onAction={() => router.replace('/(tabs)/plan')}
            secondaryLabel="Browse recipes"
            onSecondary={() => router.replace('/(tabs)/recipes')}
          />
        </View>
      </Screen>
    );
  }

  // The effect above has already fired; keep something sensible on screen for
  // the frame before the router swaps.
  return (
    <Screen header={{ title: list.title ?? 'Grocery list', back: true, onBack: () => router.back() }}>
      <View style={{ gap: spacing.md, alignItems: 'center' }}>
        <Text variant="bodySmall" tone="secondary">
          Opening your list…
        </Text>
        <Button label="Open now" onPress={() => router.replace(`/grocery/${list.id}`)} />
      </View>
    </Screen>
  );
}
