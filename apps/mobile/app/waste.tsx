import React, { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import {
  INGREDIENT_CATEGORIES,
  WASTE_REASONS,
  type CreateWasteLogInput,
  type WasteDto,
} from '@platematch/shared';
import { categoryIcon, colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Screen } from '../components/ui/Screen.js';
import { Text } from '../components/ui/Text.js';
import { Card } from '../components/ui/Card.js';
import { Button, IconButton } from '../components/ui/Button.js';
import { Badge } from '../components/ui/Badge.js';
import { Chip } from '../components/ui/Chip.js';
import { Input, SelectField, QuantityStepper } from '../components/ui/Input.js';
import { Sheet, OptionSheet, type SheetOption } from '../components/ui/Sheet.js';
import { EmptyState, ErrorState } from '../components/ui/EmptyState.js';
import { ListRowSkeleton } from '../components/ui/Skeleton.js';
import { WasteSummaryCard, WasteImpactCard } from '../components/WasteStatCard.js';
import { LineChart } from '../components/charts/LineChart.js';
import { useDeleteWasteLog, useLogWaste, useWasteImpact, useWasteLogs, useWasteStats } from '../hooks/useApi.js';
import { formatCo2, formatMoney, formatTimeAgo, humanize, pluralize } from '../lib/format.js';

/**
 * Food waste (Section 6, Screen 12).
 *
 * Three jobs on one screen, in the order someone actually uses them: log what
 * just went in the bin (fast, two taps), then see what it is costing, then see
 * the trend. Logging is frictionless on purpose — the service derives grams, CO₂e
 * and cost server-side, so the form only needs a name and a reason.
 */

type Period = 'week' | 'month' | 'year';
type Tab = 'log' | 'impact' | 'history';

const PERIODS: Array<{ value: Period; labelKey: string }> = [
  { value: 'week', labelKey: 'thisWeek' },
  { value: 'month', labelKey: 'thisMonth' },
  { value: 'year', labelKey: 'thisYear' },
];

export default function WasteScreen(): React.ReactElement {
  const { t } = useTranslation('waste');
  const router = useRouter();
  const params = useLocalSearchParams<{ log?: string; item?: string; reason?: string }>();

  const [tab, setTab] = useState<Tab>(params.log === '1' ? 'log' : 'impact');
  const [period, setPeriod] = useState<Period>('week');
  const [showLog, setShowLog] = useState(params.log === '1');

  const { data: stats, isLoading: statsLoading } = useWasteStats(period);
  const { data: impact } = useWasteImpact();
  const { data: logs, isLoading: logsLoading, isError, error, refetch } = useWasteLogs({ period, limit: 50 });
  const logWaste = useLogWaste();
  const deleteLog = useDeleteWasteLog();

  // --- Log form state ------------------------------------------------------
  const [itemName, setItemName] = useState(params.item ?? '');
  const [reason, setReason] = useState<string>(params.reason ?? 'expired');
  const [category, setCategory] = useState<string | undefined>();
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState('pieces');
  const [notes, setNotes] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const [reasonSheet, setReasonSheet] = useState(false);
  const [categorySheet, setCategorySheet] = useState(false);
  const [unitSheet, setUnitSheet] = useState(false);

  const reasonOptions: Array<SheetOption<string>> = WASTE_REASONS.map((value) => ({
    value,
    label: t(`reasons.${value}`, { defaultValue: humanize(value) }),
    icon: reasonIcon(value),
  }));

  const categoryOptions: Array<SheetOption<string>> = [
    { value: '', label: 'Guess automatically' },
    ...INGREDIENT_CATEGORIES.map((value) => ({ value, label: `${categoryIcon(value)}  ${humanize(value)}` })),
  ];

  const unitOptions: Array<SheetOption<string>> = ['pieces', 'g', 'kg', 'ml', 'l', 'cups', 'cans'].map((value) => ({
    value,
    label: humanize(value),
  }));

  const trend = useMemo(
    () =>
      (stats?.daily ?? []).map((point) => ({
        // Show only the day number; a full date will not fit seven times.
        label: point.date.slice(8),
        value: point.co2_kg ?? point.cost_usd ?? 0,
      })),
    [stats?.daily],
  );

  const handleLog = async (): Promise<void> => {
    if (!itemName.trim()) {
      setNameError('Tell us what was wasted');
      return;
    }

    const input: CreateWasteLogInput = {
      item_name: itemName.trim(),
      reason: reason as CreateWasteLogInput['reason'],
      category: (category || undefined) as CreateWasteLogInput['category'],
      quantity,
      unit: unit as CreateWasteLogInput['unit'],
      notes: notes.trim() || null,
    };

    try {
      const created = await logWaste.mutateAsync(input);

      // Show the computed impact immediately — that feedback loop is what makes
      // people keep logging.
      toastImpact(created);

      setItemName('');
      setNotes('');
      setQuantity(1);
      setNameError(null);
      setShowLog(false);
      setTab('impact');
      await refetch();
    } catch {
      // The mutation hook already surfaced the message.
    }
  };

  const toastImpact = (created: WasteDto): void => {
    const cost = created.estimated_cost ?? 0;
    const co2 = created.co2_equivalent_kg ?? 0;
    // Imported lazily to keep this module's import graph shallow.
    void import('../stores/ui.store.js').then(({ toast }) =>
      toast(`Logged — ${formatMoney(cost)} and ${formatCo2(co2)}`, 'success', { durationMs: 4000 }),
    );
  };

  return (
    <Screen
      header={{
        title: t('title'),
        large: true,
        back: true,
        onBack: () => router.back(),
        right: <IconButton icon="add" onPress={() => setShowLog(true)} accessibilityLabel={t('logTitle')} testID="waste-add" />,
      }}
      padding={false}
      testID="waste-screen"
      contentStyle={{ paddingBottom: spacing.huge * 2 }}
      footer={<Button label={t('submit')} icon="add-circle" onPress={() => setShowLog(true)} block size="lg" testID="waste-log-cta" />}
    >
      {/* --- Tabs ------------------------------------------------------------ */}
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {(['log', 'impact', 'history'] as const).map((value) => (
            <Chip
              key={value}
              label={value === 'log' ? 'Summary' : value === 'impact' ? t('impact') : t('history')}
              selected={tab === value}
              onPress={() => setTab(value)}
              testID={`waste-tab-${value}`}
            />
          ))}
        </View>

        {tab !== 'history' ? (
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {PERIODS.map((option) => (
              <Chip
                key={option.value}
                label={t(option.labelKey)}
                selected={period === option.value}
                onPress={() => setPeriod(option.value)}
                size="sm"
              />
            ))}
          </View>
        ) : null}
      </View>

      {/* --- Summary / impact ------------------------------------------------ */}
      {tab !== 'history' ? (
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg }}>
          {statsLoading ? (
            <ListRowSkeleton />
          ) : stats ? (
            <WasteSummaryCard stats={stats} period={period} testID="waste-summary" />
          ) : null}

          {trend.length > 1 ? (
            <Card padding="lg" style={{ gap: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Text variant="headingSmall">Daily CO₂e</Text>
                <Text variant="captionSmall" tone="tertiary">
                  {formatCo2(stats?.total_co2_kg ?? 0)} total
                </Text>
              </View>
              <LineChart data={trend} height={140} width={320} color={colors.secondary} testID="waste-trend" />
            </Card>
          ) : null}

          {impact ? <WasteImpactCard impact={impact} testID="waste-impact" /> : null}

          {stats && stats.money_saved_usd > 0 ? (
            <Card padding="lg" style={{ gap: spacing.xs, backgroundColor: colors.successSoft }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Ionicons name="trophy-outline" size={sizes.iconMd} color={colors.success} />
                <Text variant="headingSmall" tone="success">
                  {formatMoney(stats.money_saved_usd)} saved this {period}
                </Text>
              </View>
              <Text variant="bodySmall" tone="secondary">
                That is food you bought and actually ate instead of binned
                {stats.waste_free_days > 0 ? `, plus ${pluralize(stats.waste_free_days, 'waste-free day')}` : ''}.
              </Text>
            </Card>
          ) : null}
        </View>
      ) : null}

      {/* --- History --------------------------------------------------------- */}
      {tab === 'history' ? (
        isError ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
          </View>
        ) : (
          <FlatList
            data={logs?.items ?? []}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.lg }}
            ListEmptyComponent={
              logsLoading ? (
                <View style={{ gap: spacing.sm }}>
                  {[0, 1, 2, 3].map((index) => (
                    <ListRowSkeleton key={index} />
                  ))}
                </View>
              ) : (
                <EmptyState
                  icon="leaf-outline"
                  tone="primary"
                  title={t('emptyTitle')}
                  description={t('emptyBody')}
                  actionLabel={t('emptyAction')}
                  onAction={() => setShowLog(true)}
                  testID="waste-empty"
                />
              )
            }
            renderItem={({ item }) => (
              <Card padding="md" style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }} testID={`waste-log-${item.id}`}>
                <View style={{ width: 40, height: 40, borderRadius: radii.sm, backgroundColor: colors.dangerSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 18 }}>{categoryIcon(item.category)}</Text>
                </View>

                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="bodyMedium" numberOfLines={1}>
                    {item.item_name}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Text variant="captionSmall" tone="tertiary">
                      {formatTimeAgo(item.logged_at)}
                    </Text>
                    <Badge label={t(`reasons.${item.reason}`, { defaultValue: humanize(item.reason) })} tone="neutral" size="sm" />
                    {item.estimated_cost ? (
                      <Text variant="captionSmall" tone="danger">
                        {formatMoney(item.estimated_cost)}
                      </Text>
                    ) : null}
                    {item.co2_equivalent_kg ? (
                      <Text variant="captionSmall" tone="tertiary">
                        {formatCo2(item.co2_equivalent_kg)}
                      </Text>
                    ) : null}
                  </View>
                  {item.notes ? (
                    <Text variant="captionSmall" tone="tertiary" numberOfLines={2}>
                      {item.notes}
                    </Text>
                  ) : null}
                </View>

                <IconButton
                  icon="trash-outline"
                  size="sm"
                  onPress={() => void deleteLog.mutateAsync(item.id)}
                  accessibilityLabel={`Delete ${item.item_name}`}
                />
              </Card>
            )}
          />
        )
      ) : null}

      {/* --- Log sheet ------------------------------------------------------- */}
      <Sheet
        visible={showLog}
        onClose={() => setShowLog(false)}
        title={t('logTitle')}
        subtitle={t('logSubtitle')}
        testID="waste-log-sheet"
        footer={<Button label={t('submit')} icon="checkmark" onPress={() => void handleLog()} loading={logWaste.isPending} block size="lg" testID="waste-log-submit" />}
      >
        <Input
          label={t('itemName')}
          value={itemName}
          onChangeText={(value) => {
            setItemName(value);
            if (nameError) setNameError(null);
          }}
          placeholder="e.g. Baby spinach"
          error={nameError}
          icon="nutrition-outline"
          autoFocus
          testID="waste-log-name"
        />

        <SelectField label={t('reason')} value={t(`reasons.${reason}`, { defaultValue: humanize(reason) })} onPress={() => setReasonSheet(true)} icon="help-circle-outline" testID="waste-log-reason" />

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('quantity')}
          </Text>
          <QuantityStepper value={quantity} onChange={setQuantity} min={0} step={unit === 'pieces' ? 1 : 0.25} suffix={unit === 'pieces' ? undefined : unit} testID="waste-log-quantity" />
          <Text variant="captionSmall" tone="tertiary">
            We convert to grams for the CO₂ maths, so an estimate is fine.
          </Text>
        </View>

        <SelectField label={t('pantry:unit', { ns: 'pantry' })} value={humanize(unit)} onPress={() => setUnitSheet(true)} icon="scale-outline" testID="waste-log-unit" />
        <SelectField label={t('category')} value={category ? humanize(category) : undefined} placeholder="Guess automatically" onPress={() => setCategorySheet(true)} icon="pricetags-outline" testID="waste-log-category" />

        <Input
          label={t('notes')}
          value={notes}
          onChangeText={setNotes}
          placeholder="Bought too much, forgot about it at the back…"
          multiline
          numberOfLines={3}
          textAlignVertical="top"
          hint={t('common:optional', { ns: 'common' })}
        />

        <View style={{ flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.primarySoft }}>
          <Ionicons name="information-circle-outline" size={sizes.iconSm} color={colors.primary} />
          <Text variant="captionSmall" tone="secondary" style={{ flex: 1 }}>
            Cost and CO₂e are calculated for you from the ingredient and category — you do not need to look anything up.
          </Text>
        </View>
      </Sheet>

      <OptionSheet visible={reasonSheet} onClose={() => setReasonSheet(false)} onSelect={setReason} options={reasonOptions} selected={reason} title={t('reason')} />
      <OptionSheet visible={categorySheet} onClose={() => setCategorySheet(false)} onSelect={(value) => setCategory(value || undefined)} options={categoryOptions} selected={category ?? ''} title={t('category')} />
      <OptionSheet visible={unitSheet} onClose={() => setUnitSheet(false)} onSelect={setUnit} options={unitOptions} selected={unit} title={t('pantry:unit', { ns: 'pantry' })} />
    </Screen>
  );
}

function reasonIcon(reason: string): keyof typeof Ionicons.glyphMap {
  switch (reason) {
    case 'expired':
      return 'calendar-outline';
    case 'spoiled':
      return 'warning-outline';
    case 'leftover':
      return 'restaurant-outline';
    case 'overcooked':
      return 'flame-outline';
    case 'didnt_like':
      return 'thumbs-down-outline';
    default:
      return 'ellipsis-horizontal-outline';
  }
}
