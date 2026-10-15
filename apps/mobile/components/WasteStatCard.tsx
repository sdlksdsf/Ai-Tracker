import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Card } from './ui/Card.js';
import { Text } from './ui/Text.js';
import { HorizontalBarChart } from './charts/BarChart.js';
import { formatCo2, formatMoney, formatPercent, formatWeight, pluralize } from '../lib/format.js';
import type { WasteImpactDto, WasteStatsDto } from '@platematch/shared';

/**
 * Waste impact (Section 6, Screen 11).
 *
 * The framing matters more than the arithmetic: "kg CO₂e" is abstract, so every
 * total is paired with an equivalent the user can picture — trees, meals, and how
 * they compare with the UNEP household average.
 */

export function WasteSummaryCard({
  stats,
  period,
  currency = 'USD',
  testID,
}: {
  stats: WasteStatsDto;
  period: string;
  currency?: string;
  testID?: string;
}): React.ReactElement {
  // A fall in waste is the good direction, so the sign is inverted for colour.
  const improved = stats.cost_change_pct < 0;
  const preventablePct = stats.total_cost_usd > 0 ? (stats.preventable_cost_usd / stats.total_cost_usd) * 100 : 0;

  return (
    <Card padding="xl" testID={testID} style={{ gap: spacing.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="overline" tone="tertiary">
            {period.toUpperCase()}
          </Text>
          <Text variant="displaySmall">{formatWeight(stats.total_grams)}</Text>
          <Text variant="bodySmall" tone="secondary">
            {pluralize(stats.total_logs, 'entry', 'entries')} logged
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Text variant="statSmall" tone={improved ? 'success' : 'danger'}>
            {formatPercent(stats.cost_change_pct, true)}
          </Text>
          <Text variant="captionSmall" tone="tertiary" style={{ maxWidth: 120, textAlign: 'right' }}>
            vs. previous {period}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <MiniStat icon="cash-outline" label="Money lost" value={formatMoney(stats.total_cost_usd, currency)} tone={colors.danger} />
        <MiniStat icon="cloud-outline" label="CO₂e" value={formatCo2(stats.total_co2_kg)} tone={colors.textSecondary} />
        <MiniStat icon="leaf-outline" label="Preventable" value={formatPercent(preventablePct)} tone={colors.warning} />
      </View>

      {stats.waste_free_days > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            padding: spacing.md,
            borderRadius: radii.md,
            backgroundColor: colors.successSoft,
          }}
        >
          <Text style={{ fontSize: 18 }}>🔥</Text>
          <Text variant="caption" tone="success">
            {pluralize(stats.waste_free_days, 'waste-free day')}
          </Text>
        </View>
      ) : null}

      {stats.by_category?.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            By category
          </Text>
          <HorizontalBarChart
            data={stats.by_category.slice(0, 5).map((entry) => ({
              label: humanizeCategory(entry.key),
              value: entry.cost_usd,
              displayValue: formatMoney(entry.cost_usd, currency),
              color: colors.secondary,
            }))}
            testID={testID ? `${testID}-categories` : undefined}
          />
        </View>
      ) : null}

      {stats.by_reason?.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Why it was wasted
          </Text>
          <HorizontalBarChart
            data={stats.by_reason.slice(0, 4).map((entry) => ({
              label: humanizeCategory(entry.key),
              value: entry.count,
              displayValue: pluralize(entry.count, 'time'),
              color: colors.textTertiary,
            }))}
            testID={testID ? `${testID}-reasons` : undefined}
          />
        </View>
      ) : null}
    </Card>
  );
}

function MiniStat({ icon, label, value, tone }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; tone: string }): React.ReactElement {
  return (
    <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={sizes.iconSm} color={tone} />
      <Text variant="caption" numberOfLines={1}>
        {value}
      </Text>
      <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function WasteImpactCard({ impact, testID }: { impact: WasteImpactDto; testID?: string }): React.ReactElement {
  const equivalents = [
    { icon: '🌳', label: 'Trees needed to absorb your CO₂', value: formatNumber(impact.equivalent_trees) },
    { icon: '🍽️', label: "Meals' worth of food wasted", value: formatNumber(impact.equivalent_meals) },
    { icon: '⚖️', label: 'Your weekly waste', value: `${formatNumber(impact.user_kg_per_week)} kg` },
    { icon: '🌍', label: 'Household average (UNEP)', value: `${formatNumber(impact.national_average_kg_per_week)} kg` },
  ];

  return (
    <Card padding="xl" testID={testID} style={{ gap: spacing.md }}>
      <View style={{ gap: 2 }}>
        <Text variant="headingSmall">What it adds up to</Text>
        <Text variant="bodySmall" tone="secondary">
          Since you started tracking
        </Text>
      </View>

      <View style={{ gap: spacing.md }}>
        {equivalents.map((row) => (
          <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: radii.sm,
                backgroundColor: colors.surfaceAlt,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 18 }}>{row.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="secondary" numberOfLines={2}>
                {row.label}
              </Text>
            </View>
            <Text variant="bodyMedium" style={{ maxWidth: 120, textAlign: 'right' }}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>

      {/* Framing the number against a real benchmark is what makes it actionable. */}
      <View
        style={{
          gap: 4,
          padding: spacing.md,
          borderRadius: radii.md,
          backgroundColor: impact.better_than_average ? colors.successSoft : colors.warningSoft,
        }}
      >
        <Text variant="caption" tone={impact.better_than_average ? 'success' : 'warning'}>
          {impact.better_than_average
            ? 'You waste less than the average household.'
            : 'You waste more than the average household — the plan is where to start.'}
        </Text>
        <Text variant="captionSmall" tone="secondary">
          Lifetime cost of wasted food: {formatMoney(impact.lifetime_cost_usd)} · {formatCo2(impact.lifetime_co2_kg)}
        </Text>
      </View>
    </Card>
  );
}

function formatNumber(value: number | null | undefined): string {
  const num = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (Math.abs(num) >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

function humanizeCategory(category: string | null | undefined): string {
  if (!category) return 'Other';
  return category
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default WasteSummaryCard;
