import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, SectionList, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import {
  INGREDIENT_CATEGORIES,
  STORAGE_LOCATIONS,
  type CreatePantryItemInput,
  type PantryItemDto,
} from '@platematch/shared';
import { categoryIcon, colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Screen } from '../components/ui/Screen.js';
import { Text } from '../components/ui/Text.js';
import { Button, IconButton } from '../components/ui/Button.js';
import { Chip } from '../components/ui/Chip.js';
import { Input, SelectField, QuantityStepper } from '../components/ui/Input.js';
import { Sheet, OptionSheet, type SheetOption } from '../components/ui/Sheet.js';
import { FAB } from '../components/ui/FAB.js';
import { EmptyState, ErrorState } from '../components/ui/EmptyState.js';
import { ListRowSkeleton } from '../components/ui/Skeleton.js';
import { PantryItemRow } from '../components/PantryItemRow.js';
import { StatCard, StatGrid } from '../components/StatCard.js';
import {
  useCreatePantryItem,
  useDeletePantryItem,
  useMarkPantryUsed,
  usePantry,
  usePantryStats,
} from '../hooks/useApi.js';
import { useDebouncedValue } from '../hooks/index.js';
import { formatDate, formatMoney, humanize } from '../lib/format.js';
import { toLocalIsoDate } from '../lib/parse.js';
import { toast } from '../stores/ui.store.js';

/**
 * Pantry (Section 6, Screen 9).
 *
 * Grouped by storage location by default, because that is how someone physically
 * goes through a kitchen — fridge, then freezer, then cupboard. The filter bar
 * switches the grouping to expiry urgency or category.
 */

type FilterKey = 'all' | 'expiring' | 'expired' | 'fridge' | 'freezer' | 'pantry';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'expiring', label: 'Expiring soon' },
  { key: 'expired', label: 'Expired' },
  { key: 'fridge', label: 'Fridge' },
  { key: 'freezer', label: 'Freezer' },
  { key: 'pantry', label: 'Cupboard' },
];

export default function PantryScreen(): React.ReactElement {
  const { t } = useTranslation('pantry');
  const router = useRouter();
  const params = useLocalSearchParams<{ add?: string; filter?: string; highlight?: string }>();

  const [filter, setFilter] = useState<FilterKey>((params.filter as FilterKey) ?? 'all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);

  const [showAdd, setShowAdd] = useState(Boolean(params.add));
  const [editing, setEditing] = useState<PantryItemDto | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PantryItemDto | null>(null);

  const query = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      expired: filter === 'expired' ? true : filter === 'all' || filter === 'expiring' ? false : undefined,
      location: filter === 'fridge' || filter === 'freezer' || filter === 'pantry' ? filter : undefined,
      sort: 'expiry_date' as const,
      limit: 100,
    }),
    [debouncedSearch, filter],
  );

  const { data, isLoading, isError, error, refetch, isRefetching } = usePantry(query);
  const { data: stats } = usePantryStats();
  const createItem = useCreatePantryItem();
  const markUsed = useMarkPantryUsed();
  const deleteItem = useDeletePantryItem();

  const items = useMemo(() => data?.items ?? [], [data]);

  // "Expiring soon" is a client-side filter over the fetched rows, so the
  // urgency buckets stay consistent with the API's own expiryUrgency().
  const visible = useMemo(() => {
    if (filter !== 'expiring') return items;
    return items.filter((item) => {
      const days = item.days_until_expiry;
      return days !== null && days !== undefined && days >= 0 && days <= 5;
    });
  }, [filter, items]);

  const sections = useMemo(() => {
    const grouped = new Map<string, PantryItemDto[]>();

    for (const item of visible) {
      const key = filter === 'fridge' || filter === 'freezer' || filter === 'pantry'
        ? humanize(item.location ?? 'fridge')
        : groupLabel(item);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }

    return [...grouped.entries()].map(([title, rows]) => ({ title, data: rows }));
  }, [visible, filter]);

  return (
    <Screen
      header={{
        title: t('title'),
        large: true,
        right: <IconButton icon="stats-chart-outline" onPress={() => router.push('/waste')} accessibilityLabel={t('stats')} />,
      }}
      padding={false}
      testID="pantry-screen"
    >
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder={t('searchPlaceholder')}
          icon="search-outline"
          autoCapitalize="none"
          autoCorrect={false}
          testID="pantry-search"
        />

        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={FILTERS}
          keyExtractor={(item) => item.key}
          contentContainerStyle={{ gap: spacing.sm }}
          renderItem={({ item }) => (
            <Chip
              label={item.label}
              selected={filter === item.key}
              onPress={() => setFilter(item.key)}
              testID={`pantry-filter-${item.key}`}
            />
          )}
        />

        {stats ? (
          <StatGrid>
            <StatCard label={t('totalItems', { count: stats.total_items })} value={String(stats.total_items)} icon="file-tray-full-outline" compact testID="pantry-stat-total" />
            <StatCard
              label="Expiring soon"
              value={String(stats.expiring_soon)}
              icon="alert-circle-outline"
              tone={stats.expiring_soon > 0 ? colors.warning : colors.success}
              softTone={stats.expiring_soon > 0 ? colors.warningSoft : colors.successSoft}
              compact
            />
            <StatCard label="Estimated value" value={formatMoney(stats.total_estimated_value)} icon="pricetag-outline" tone={colors.accent} softTone={colors.accentSoft} compact />
          </StatGrid>
        ) : null}
      </View>

      {isError && !items.length ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
        </View>
      ) : isLoading ? (
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
          {[0, 1, 2, 3, 4].map((index) => (
            <ListRowSkeleton key={index} />
          ))}
        </View>
      ) : !visible.length ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <EmptyState
            icon="file-tray-outline"
            tone="primary"
            title={items.length ? 'Nothing matches that filter' : t('emptyTitle')}
            description={items.length ? 'Try a different filter or clear the search.' : t('emptyBody')}
            actionLabel={items.length ? 'Clear filters' : t('emptyAction')}
            onAction={() => {
              if (items.length) {
                setFilter('all');
                setSearch('');
              } else {
                setShowAdd(true);
              }
            }}
            secondaryLabel={items.length ? undefined : 'Scan my fridge'}
            onSecondary={items.length ? undefined : () => router.push('/(tabs)/scan')}
            testID="pantry-empty"
          />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.huge * 2, gap: spacing.xs }}
          renderSectionHeader={({ section }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md, backgroundColor: colors.background }}>
              <Text variant="overline" tone="secondary">
                {section.title.toUpperCase()}
              </Text>
              <Text variant="captionSmall" tone="tertiary">
                {section.data.length}
              </Text>
            </View>
          )}
          renderItem={({ item }) => (
            <PantryItemRow
              item={item}
              testID={`pantry-item-${item.id}`}
              selected={params.highlight === item.id}
              onPress={() => setEditing(item)}
              onUse={() => void markUsed.mutateAsync(item.id)}
              onLongPress={() => setConfirmDelete(item)}
            />
          )}
          refreshControl={<RefreshControl refreshing={isRefetching && !isLoading} onRefresh={() => void refetch()} tintColor={colors.primary} colors={[colors.primary]} />}
        />
      )}

      <FAB icon="add" onPress={() => { setEditing(null); setShowAdd(true); }} label="Add item" extended accessibilityLabel={t('addTitle')} testID="pantry-add" />

      <AddEditSheet
        visible={showAdd || Boolean(editing)}
        item={editing}
        onClose={() => { setShowAdd(false); setEditing(null); }}
        onSubmit={async (input) => {
          if (editing) {
            // Editing reuses the create mutation's shape via PATCH.
            const { api } = await import('../lib/api.js');
            await api.patch(`/pantry/${editing.id}`, input);
            toast('Item updated', 'success');
          } else {
            await createItem.mutateAsync(input);
          }
          setShowAdd(false);
          setEditing(null);
          await refetch();
        }}
        pending={createItem.isPending}
      />

      <Sheet
        visible={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={t('deleteConfirmTitle')}
        subtitle={confirmDelete ? t('deleteConfirmBody', { name: confirmDelete.ingredient_name }) : undefined}
        scrollable={false}
        testID="pantry-delete"
      >
        <View style={{ gap: spacing.md }}>
          <Button
            label={t('logAsWaste')}
            icon="trash-outline"
            variant="outline"
            onPress={() => {
              const item = confirmDelete;
              setConfirmDelete(null);
              if (item) router.push(`/waste?log=1&item=${encodeURIComponent(item.ingredient_name)}`);
            }}
            block
          />
          <Button
            label={t('common:delete', { ns: 'common' })}
            icon="trash"
            variant="danger"
            loading={deleteItem.isPending}
            onPress={async () => {
              const item = confirmDelete;
              setConfirmDelete(null);
              if (item) await deleteItem.mutateAsync(item.id);
            }}
            block
          />
          <Button label={t('common:cancel', { ns: 'common' })} variant="ghost" onPress={() => setConfirmDelete(null)} block />
        </View>
      </Sheet>
    </Screen>
  );
}

/** Section heading for a pantry row, based on the active filter. */
function groupLabel(item: PantryItemDto): string {
  const days = item.days_until_expiry;
  if (days !== null && days !== undefined && days < 0) return 'Expired';
  if (days !== null && days !== undefined && days <= 2) return 'Use in the next 2 days';
  if (days !== null && days !== undefined && days <= 7) return 'Use this week';
  if (item.location) return humanize(item.location);
  return 'Other';
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

function AddEditSheet({
  visible,
  item,
  onClose,
  onSubmit,
  pending,
}: {
  visible: boolean;
  item: PantryItemDto | null;
  onClose: () => void;
  onSubmit: (input: CreatePantryItemInput) => Promise<void>;
  pending: boolean;
}): React.ReactElement {
  const { t } = useTranslation('pantry');

  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState('pieces');
  const [category, setCategory] = useState<string>('other');
  const [location, setLocation] = useState<string>('fridge');
  const [expiryDate, setExpiryDate] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const [unitSheet, setUnitSheet] = useState(false);
  const [categorySheet, setCategorySheet] = useState(false);
  const [locationSheet, setLocationSheet] = useState(false);

  // Reset the form whenever the sheet opens, so a cancelled edit does not leak
  // into the next "add".
  React.useEffect(() => {
    if (!visible) return;
    setName(item?.ingredient_name ?? '');
    setQuantity(item?.quantity ?? 1);
    setUnit(item?.unit ?? 'pieces');
    setCategory(item?.category ?? 'other');
    setLocation(item?.location ?? 'fridge');
    setExpiryDate(item?.expiry_date ?? null);
    setNameError(null);
  }, [visible, item]);

  const unitOptions: Array<SheetOption<string>> = ['pieces', 'g', 'kg', 'ml', 'l', 'cups', 'tbsp', 'tsp', 'cloves', 'slices', 'cans', 'bunches'].map(
    (value) => ({ value, label: humanize(value) }),
  );
  const categoryOptions: Array<SheetOption<string>> = INGREDIENT_CATEGORIES.map((value) => ({
    value,
    label: `${categoryIcon(value)}  ${humanize(value)}`,
  }));
  const locationOptions: Array<SheetOption<string>> = STORAGE_LOCATIONS.map((value) => ({
    value,
    label: humanize(value),
    icon: value === 'fridge' ? 'snow-outline' : value === 'freezer' ? 'cube-outline' : 'archive-outline',
  }));

  const handleSubmit = async (): Promise<void> => {
    if (!name.trim()) {
      setNameError('Enter an ingredient name');
      return;
    }

    await onSubmit({
      ingredient_name: name.trim(),
      quantity,
      unit: unit as CreatePantryItemInput['unit'],
      category: category as CreatePantryItemInput['category'],
      location: location as CreatePantryItemInput['location'],
      expiry_date: expiryDate,
      added_via: item?.added_via ?? 'manual',
      ai_confidence: item?.ai_confidence ?? null,
      photo_url: item?.photo_url ?? null,
    });
  };

  return (
    <>
      <Sheet
        visible={visible}
        onClose={onClose}
        title={item ? t('editTitle') : t('addTitle')}
        testID="pantry-form"
        footer={
          <Button label={t('common:save', { ns: 'common' })} icon="checkmark" onPress={() => void handleSubmit()} loading={pending} block size="lg" />
        }
      >
        <Input
          label={t('ingredientName')}
          value={name}
          onChangeText={(value) => {
            setName(value);
            if (nameError) setNameError(null);
          }}
          placeholder="e.g. Greek yoghurt"
          error={nameError}
          icon="nutrition-outline"
          autoCapitalize="words"
          testID="pantry-form-name"
        />

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('quantity')}
          </Text>
          <QuantityStepper value={quantity} onChange={setQuantity} min={0} step={unit === 'pieces' ? 1 : 0.5} suffix={unit === 'pieces' ? undefined : unit} testID="pantry-form-quantity" />
        </View>

        <SelectField label={t('unit')} value={humanize(unit)} onPress={() => setUnitSheet(true)} icon="scale-outline" testID="pantry-form-unit" />
        <SelectField label={t('category')} value={humanize(category)} onPress={() => setCategorySheet(true)} icon="pricetags-outline" testID="pantry-form-category" />
        <SelectField label={t('location')} value={humanize(location)} onPress={() => setLocationSheet(true)} icon="home-outline" testID="pantry-form-location" />

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('expiryDate')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {[1, 3, 5, 7, 14, 30].map((days) => {
              const iso = toLocalIsoDate(new Date(Date.now() + days * 86_400_000));
              return <Chip key={days} label={`${days}d`} selected={expiryDate === iso} onPress={() => setExpiryDate(iso)} size="sm" />;
            })}
            <Chip label={t('noExpiry')} selected={expiryDate === null} onPress={() => setExpiryDate(null)} size="sm" />
          </View>
          {expiryDate ? (
            <Text variant="captionSmall" tone="tertiary">
              {t('estimatedExpiry', { date: formatDate(expiryDate) })}
            </Text>
          ) : (
            <Text variant="captionSmall" tone="tertiary">
              Leave it blank and we will estimate one from the ingredient&apos;s typical shelf life.
            </Text>
          )}
        </View>
      </Sheet>

      <OptionSheet visible={unitSheet} onClose={() => setUnitSheet(false)} onSelect={setUnit} options={unitOptions} selected={unit} title={t('unit')} />
      <OptionSheet visible={categorySheet} onClose={() => setCategorySheet(false)} onSelect={setCategory} options={categoryOptions} selected={category} title={t('category')} />
      <OptionSheet visible={locationSheet} onClose={() => setLocationSheet(false)} onSelect={setLocation} options={locationOptions} selected={location} title={t('location')} />
    </>
  );
}
