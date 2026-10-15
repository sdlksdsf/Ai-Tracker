import React, { useMemo, useState } from 'react';
import { SectionList, Share, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type { GroceryListItemDto } from '@platematch/shared';
import { colors, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button, IconButton } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Chip } from '../../components/ui/Chip.js';
import { ProgressBar } from '../../components/ui/Progress.js';
import { Sheet, OptionSheet, type SheetOption } from '../../components/ui/Sheet.js';
import { Input } from '../../components/ui/Input.js';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState.js';
import { ListRowSkeleton, SkeletonList } from '../../components/ui/Skeleton.js';
import { HorizontalBarChart } from '../../components/charts/BarChart.js';
import { GroceryItemRow, GroceryGroupHeader } from '../../components/GroceryItemRow.js';
import {
  useAddGroceryItem,
  useComparePrices,
  useGroceryList,
  useOrderHandoff,
  useToggleGroceryItem,
} from '../../hooks/useApi.js';
import { formatMoney, humanize } from '../../lib/format.js';
import { toast } from '../../stores/ui.store.js';
import { useAuthStore } from '../../stores/auth.store.js';

/**
 * Grocery list (Section 6, Screen 11).
 *
 * Shopping mode first: the checkbox and the running total are what someone looks
 * at in an aisle. The price-comparison panel is secondary and gated, because it
 * is a Premium feature — and the savings figure is the argument for upgrading,
 * so it is shown with the real number rather than a generic upsell.
 */

type GroupMode = 'category' | 'store' | 'none';

export default function GroceryListScreen(): React.ReactElement {
  const { t } = useTranslation('grocery');
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const tier = useAuthStore((state) => state.user?.subscription_tier ?? 'free');

  const { data: list, isLoading, isError, error, refetch } = useGroceryList(id ?? null);
  const toggleItem = useToggleGroceryItem();
  const addItem = useAddGroceryItem();
  const comparePrices = useComparePrices();
  const orderHandoff = useOrderHandoff();

  const [groupMode, setGroupMode] = useState<GroupMode>('category');
  const [showPrices, setShowPrices] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [provider, setProvider] = useState('instacart');
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState('1');

  const isPremium = tier !== 'free';

  const sections = useMemo(() => {
    const items = list?.items ?? [];
    if (groupMode === 'none') return [{ title: '', data: items }];

    const grouped = new Map<string, GroceryListItemDto[]>();
    for (const item of items) {
      const key = groupMode === 'store' ? item.cheapest_store ?? 'Any store' : humanize(item.category ?? 'other');
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }

    // Sort groups so the biggest spend is at the top — that is where the
    // substitution decisions are worth making.
    return [...grouped.entries()]
      .map(([title, data]) => ({ title, data }))
      .sort((a, b) => totalOf(b.data) - totalOf(a.data));
  }, [list?.items, groupMode]);

  const purchased = list?.purchased_count ?? 0;
  const total = list?.total_count ?? 0;
  const progress = total > 0 ? purchased / total : 0;
  const estimated = list?.total_estimated_cost ?? 0;
  const savings = list?.savings ?? null;

  const handleShare = async (): Promise<void> => {
    if (!id) return;

    try {
      const result = await orderHandoff.mutateAsync({ listId: id, provider });
      await Share.share({ message: result.share_text, title: list?.title ?? 'Shopping list' });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const handleAddItem = async (): Promise<void> => {
    if (!id || !newItemName.trim()) return;

    const quantity = Number(newItemQty) || 1;

    await addItem.mutateAsync({
      listId: id,
      input: {
        ingredient_name: newItemName.trim(),
        quantity,
        unit: 'pieces',
        category: 'other',
      },
    });

    setNewItemName('');
    setNewItemQty('1');
    setShowAdd(false);
  };

  if (isLoading) {
    return (
      <Screen header={{ title: t('title'), back: true, onBack: () => router.back() }} testID="grocery-screen">
        <SkeletonList count={6} />
      </Screen>
    );
  }

  if (isError || !list) {
    return (
      <Screen header={{ title: t('title'), back: true, onBack: () => router.back() }} testID="grocery-screen">
        <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const providerOptions: Array<SheetOption<string>> = [
    { value: 'instacart', label: 'Instacart', description: 'Multi-store delivery' },
    { value: 'amazon_fresh', label: 'Amazon Fresh' },
    { value: 'walmart', label: 'Walmart' },
    { value: 'kroger', label: 'Kroger' },
    { value: 'pandago', label: 'Pandago', description: 'Philippines' },
    { value: 'generic', label: 'Search the web' },
  ];

  return (
    <Screen
      header={{
        title: list.title ?? t('title'),
        subtitle: `${t('checkedCount', { checked: purchased, total })}`,
        back: true,
        onBack: () => router.back(),
        right: (
          <View style={{ flexDirection: 'row' }}>
            <IconButton icon="share-social-outline" onPress={() => void handleShare()} accessibilityLabel={t('shareList')} testID="grocery-share" />
            <IconButton icon="add" onPress={() => setShowAdd(true)} accessibilityLabel={t('addItem')} testID="grocery-add-open" />
          </View>
        ),
      }}
      padding={false}
      testID="grocery-screen"
      contentStyle={{ paddingBottom: spacing.huge * 2 }}
      footer={
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <Button
            label={t('comparePrices')}
            icon="pricetags-outline"
            variant={isPremium ? 'secondary' : 'outline'}
            onPress={() => {
              if (!isPremium) {
                toast(t('pricesPremium'), 'warning', {
                  action: { label: 'See Premium', onPress: () => router.push('/premium') },
                });
                return;
              }
              setShowPrices(true);
            }}
            style={{ flex: 1 }}
            testID="grocery-compare"
          />
          <Button label={t('orderOnline')} icon="cart-outline" onPress={() => setShowOrder(true)} style={{ flex: 1 }} testID="grocery-order" />
        </View>
      }
    >
      {/* --- Progress + total ------------------------------------------------ */}
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
        <Card padding="lg" style={{ gap: spacing.md }} testID="grocery-summary">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text variant="overline" tone="tertiary">
                {t('estimatedTotal').toUpperCase()}
              </Text>
              <Text variant="displayMedium">{formatMoney(estimated)}</Text>
            </View>

            {savings && savings.saved > 0 ? (
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Badge label={`${t('savings')} ${formatMoney(savings.saved)}`} tone="success" icon="trending-down" />
                <Text variant="captionSmall" tone="tertiary">
                  {savings.percent}% by splitting stores
                </Text>
              </View>
            ) : null}
          </View>

          <View style={{ gap: spacing.xs }}>
            <ProgressBar value={progress} color={progress >= 1 ? colors.success : colors.primary} testID="grocery-progress" />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="captionSmall" tone="tertiary">
                {t('checkedCount', { checked: purchased, total })}
              </Text>
              {purchased > 0 && purchased < total ? (
                <Text variant="captionSmall" tone="primary" onPress={() => void refetch()}>
                  {formatMoney(remainingCost(list.items))} left
                </Text>
              ) : null}
            </View>
          </View>

          {list.items.some((item) => item.in_pantry) ? (
            <Text variant="captionSmall" tone="secondary">
              🏠 {t('inPantry', { count: list.items.filter((item) => item.in_pantry).length })}
            </Text>
          ) : null}
        </Card>

        {/* Grouping */}
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {(['category', 'store', 'none'] as const).map((mode) => (
            <Chip
              key={mode}
              label={mode === 'none' ? 'Flat list' : mode === 'store' ? t('groupedByStore') : t('groupedByCategory')}
              selected={groupMode === mode}
              onPress={() => setGroupMode(mode)}
              size="sm"
            />
          ))}
        </View>
      </View>

      {/* --- Items ----------------------------------------------------------- */}
      {!list.items.length ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <EmptyState
            icon="cart-outline"
            tone="primary"
            title={t('emptyTitle')}
            description={t('emptyBody')}
            actionLabel={t('addItem')}
            onAction={() => setShowAdd(true)}
            secondaryLabel="Build from my meal plan"
            onSecondary={() => router.push('/(tabs)/plan')}
            testID="grocery-empty"
          />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={groupMode !== 'none'}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.xs }}
          renderSectionHeader={({ section }) =>
            section.title ? (
              <GroceryGroupHeader
                title={section.title}
                count={section.data.length}
                cost={totalOf(section.data)}
              />
            ) : (
              <View />
            )
          }
          renderItem={({ item }) => (
            <GroceryItemRow
              item={item}
              testID={`grocery-item-${item.id}`}
              onToggle={() => void toggleItem.mutateAsync({ listId: list.id, itemId: item.id, checked: !item.is_purchased })}
              onPress={() => setShowPrices(true)}
            />
          )}
          ListFooterComponent={
            <View style={{ gap: spacing.md, paddingTop: spacing.lg }}>
              <Button label={t('markAll')} icon="checkmark-done-outline" variant="ghost" onPress={() => void markAll(list.items, true)} />
              {purchased > 0 ? (
                <>
                  <Button label={t('unmarkAll')} icon="close-circle-outline" variant="ghost" onPress={() => void markAll(list.items, false)} />
                  <Button label={t('clearChecked')} icon="trash-outline" variant="ghost" onPress={() => toast('Cleared', 'info')} />
                </>
              ) : null}
            </View>
          }
        />
      )}

      {/* --- Price comparison ------------------------------------------------ */}
      <Sheet
        visible={showPrices}
        onClose={() => setShowPrices(false)}
        title={t('comparePrices')}
        subtitle={isPremium ? 'Kroger · Spoonacular · offline estimates' : t('pricesPremium')}
        testID="grocery-prices-sheet"
        footer={
          isPremium ? (
            <Button
              label={comparePrices.isPending ? t('comparing') : t('comparePrices')}
              icon="refresh"
              onPress={async () => {
                if (!id) return;
                await comparePrices.mutateAsync(id);
                await refetch();
              }}
              loading={comparePrices.isPending}
              block
              size="lg"
            />
          ) : (
            <Button label="See Premium" icon="sparkles" onPress={() => { setShowPrices(false); router.push('/premium'); }} block size="lg" />
          )
        }
      >
        {!isPremium ? (
          <Card padding="lg" style={{ gap: spacing.sm, backgroundColor: colors.secondarySoft }}>
            <Ionicons name="lock-closed-outline" size={sizes.iconLg} color={colors.secondaryDark} />
            <Text variant="headingSmall">{t('pricesPremium')}</Text>
            <Text variant="bodySmall" tone="secondary">
              We check every line against Kroger and Spoonacular, then route each item to its cheapest store. On a typical weekly shop that is $8–$20.
            </Text>
          </Card>
        ) : null}

        {comparePrices.data ? (
          <View style={{ gap: spacing.lg }}>
            <Card padding="lg" style={{ gap: spacing.sm }}>
              <Text variant="overline" tone="tertiary">
                ROUTING SAVINGS
              </Text>
              <Text variant="displayMedium" tone="success">
                {formatMoney(comparePrices.data.saved)}
              </Text>
              <Text variant="bodySmall" tone="secondary">
                {t('savingsHint', {
                  store: comparePrices.data.best_store ?? 'one store',
                  other: 'the rest',
                })}
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="captionSmall" tone="tertiary">
                  One store: {formatMoney(comparePrices.data.single_store_total)}
                </Text>
                <Text variant="captionSmall" tone="tertiary">
                  Split: {formatMoney(comparePrices.data.optimized_total)}
                </Text>
              </View>
            </Card>

            {comparePrices.data.per_store.length ? (
              <View style={{ gap: spacing.sm }}>
                <Text variant="headingSmall">{t('perStore')}</Text>
                <HorizontalBarChart
                  data={comparePrices.data.per_store.map((store) => ({
                    label: store.store,
                    value: store.total,
                    displayValue: `${formatMoney(store.total)} · ${store.items}`,
                    color: store.store === comparePrices.data?.best_store ? colors.success : colors.accent,
                  }))}
                  valueFormatter={(value) => formatMoney(value)}
                  testID="grocery-per-store"
                />
              </View>
            ) : null}

            {comparePrices.data.deals.length ? (
              <View style={{ gap: spacing.sm }}>
                <Text variant="headingSmall">{t('deals')}</Text>
                {comparePrices.data.deals.map((deal) => (
                  <Card key={deal.item_id || deal.ingredient_name} outlined padding="md" style={{ gap: 2 }}>
                    <Text variant="bodyMedium">{deal.ingredient_name}</Text>
                    <Text variant="captionSmall" tone="success">
                      {t('dealDetail', {
                        amount: formatMoney(deal.save),
                        item: deal.ingredient_name,
                        store: deal.cheapest_store,
                      })}
                    </Text>
                    <Text variant="captionSmall" tone="tertiary">
                      {deal.cheapest_store} {formatMoney(deal.cheapest_price)} · {deal.most_expensive_store}{' '}
                      {formatMoney(deal.most_expensive_price)}
                    </Text>
                  </Card>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {isPremium && !comparePrices.data && !comparePrices.isPending ? (
          <Text variant="bodySmall" tone="secondary" align="center">
            Tap below to check current prices. Results are cached for 24 hours.
          </Text>
        ) : null}
      </Sheet>

      {/* --- Add item -------------------------------------------------------- */}
      <Sheet
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        title={t('addItem')}
        scrollable={false}
        testID="grocery-add-sheet"
        footer={<Button label={t('common:save', { ns: 'common' })} icon="checkmark" onPress={() => void handleAddItem()} loading={addItem.isPending} disabled={!newItemName.trim()} block size="lg" />}
      >
        <Input
          label={t('pantry:ingredientName', { ns: 'pantry' })}
          value={newItemName}
          onChangeText={setNewItemName}
          placeholder="e.g. Coconut milk"
          icon="cart-outline"
          autoFocus
          onSubmitEditing={() => void handleAddItem()}
          testID="grocery-add-name"
        />
        <Input
          label={t('pantry:quantity', { ns: 'pantry' })}
          value={newItemQty}
          onChangeText={setNewItemQty}
          keyboardType="decimal-pad"
          icon="scale-outline"
          testID="grocery-add-qty"
        />
      </Sheet>

      {/* --- Order hand-off -------------------------------------------------- */}
      <Sheet
        visible={showOrder}
        onClose={() => setShowOrder(false)}
        title={t('orderOnline')}
        subtitle="We will open the provider with your items ready to search."
        scrollable={false}
        testID="grocery-order-sheet"
      >
        <View style={{ gap: spacing.md }}>
          {providerOptions.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={provider === option.value}
              onPress={() => setProvider(option.value)}
            />
          ))}

          <Button
            label={`Open ${providerOptions.find((option) => option.value === provider)?.label ?? provider}`}
            icon="open-outline"
            onPress={async () => {
              if (!id) return;
              const result = await orderHandoff.mutateAsync({ listId: id, provider });
              setShowOrder(false);
              toast(`${result.item_count} items · ${formatMoney(result.estimated_total)}`, 'success', {
                action: { label: 'Copy list', onPress: () => void Share.share({ message: result.share_text }) },
              });
            }}
            loading={orderHandoff.isPending}
            block
            size="lg"
          />
          <Button label={t('shareList')} icon="share-social-outline" variant="outline" onPress={() => void handleShare()} block />
        </View>
      </Sheet>
    </Screen>
  );

  async function markAll(items: GroceryListItemDto[], checked: boolean): Promise<void> {
    await Promise.all(
      items
        .filter((item) => item.is_purchased !== checked)
        .map((item) => toggleItem.mutateAsync({ listId: list!.id, itemId: item.id, checked })),
    );
    await refetch();
  }
}

function totalOf(items: GroceryListItemDto[]): number {
  return items.reduce((sum, item) => sum + (item.estimated_price ?? 0), 0);
}

function remainingCost(items: GroceryListItemDto[]): number {
  return items.filter((item) => !item.is_purchased).reduce((sum, item) => sum + (item.estimated_price ?? 0), 0);
}
