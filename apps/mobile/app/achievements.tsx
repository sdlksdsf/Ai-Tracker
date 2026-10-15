import React, { useMemo, useState } from 'react';
import { SectionList, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type { AchievementDto } from '@platematch/shared';
import { colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Screen } from '../components/ui/Screen.js';
import { Text } from '../components/ui/Text.js';
import { Card } from '../components/ui/Card.js';
import { Chip } from '../components/ui/Chip.js';
import { Sheet } from '../components/ui/Sheet.js';
import { ErrorState } from '../components/ui/EmptyState.js';
import { SkeletonList } from '../components/ui/Skeleton.js';
import { AchievementCard, LevelCard } from '../components/AchievementCard.js';
import { StatCard, StatGrid } from '../components/StatCard.js';
import { useAchievements, useAchievementsProgress } from '../hooks/useApi.js';
import { humanize } from '../lib/format.js';

/**
 * Achievements (Section 6, Screen 13).
 *
 * Locked badges stay visible with their progress, because "18 of 20 recipes
 * cooked" is the thing that makes someone cook two more. A hidden badge gives the
 * user nothing to work towards.
 */

type Filter = 'all' | 'earned' | 'progress';

export default function AchievementsScreen(): React.ReactElement {
  const { t } = useTranslation('achievements');
  const router = useRouter();

  const { data: achievements, isLoading, isError, error, refetch } = useAchievements();
  const { data: progress } = useAchievementsProgress();

  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<AchievementDto | null>(null);

  const sections = useMemo(() => {
    const all = achievements ?? [];
    const matches = (item: AchievementDto): boolean =>
      filter === 'all' ? true : filter === 'earned' ? item.earned : !item.earned;

    const grouped = new Map<string, AchievementDto[]>();
    for (const item of all) {
      if (!matches(item)) continue;
      // Earned badges group first so progress is visible above the grind.
      const key = item.earned ? 'Earned' : humanize(item.category);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }

    // Closest-to-unlocked first: that is the badge worth nudging the user about.
    return [...grouped.entries()]
      .map(([title, data]) => ({
        title,
        data: [...data].sort((a, b) => progressOf(b) - progressOf(a)),
      }))
      .sort((a, b) => (a.title === 'Earned' ? -1 : b.title === 'Earned' ? 1 : a.title.localeCompare(b.title)));
  }, [achievements, filter]);

  if (isError) {
    return (
      <Screen header={{ title: t('title'), large: true, back: true, onBack: () => router.back() }} testID="achievements-screen">
        <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: t('title'), large: true, back: true, onBack: () => router.back() }}
      padding={false}
      testID="achievements-screen"
      contentStyle={{ paddingBottom: spacing.huge * 2 }}
    >
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg }}>
        {isLoading ? (
          <SkeletonList count={3} />
        ) : (
          <>
            {progress ? (
              <LevelCard
                level={progress.level}
                levelLabel={progress.level_label}
                points={progress.points}
                nextLevelPoints={progress.next_level_points}
                streakDays={progress.streak_days}
                earned={progress.earned}
                total={progress.total}
                testID="achievements-level"
              />
            ) : null}

            <StatGrid>
              <StatCard label="Badges" value={`${progress?.earned ?? 0}/${progress?.total ?? 0}`} icon="ribbon-outline" tone={colors.primary} softTone={colors.primarySoft} compact />
              <StatCard label="Points" value={String(progress?.points ?? 0)} icon="trophy-outline" tone={colors.warning} softTone={colors.warningSoft} compact />
              <StatCard
                label={t('streakTitle')}
                value={`${progress?.streak_days ?? 0}d`}
                icon="flame-outline"
                tone={colors.secondary}
                softTone={colors.secondarySoft}
                compact
              />
            </StatGrid>
          </>
        )}

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {(['all', 'earned', 'progress'] as const).map((value) => (
            <Chip
              key={value}
              label={value === 'all' ? t('all') : value === 'earned' ? t('earned') : t('locked')}
              selected={filter === value}
              onPress={() => setFilter(value)}
              testID={`achievements-filter-${value}`}
            />
          ))}
        </View>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.lg }}
        renderSectionHeader={({ section }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md }}>
            <Text variant="overline" tone="secondary">
              {section.title.toUpperCase()}
            </Text>
            <Text variant="captionSmall" tone="tertiary">
              {section.data.filter((item) => item.earned).length}/{section.data.length}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <AchievementCard achievement={item} onPress={() => setSelected(item)} testID={`achievement-${item.key}`} />
        )}
        ListEmptyComponent={
          <Card padding="xl" style={{ gap: spacing.sm, alignItems: 'center' }}>
            <Ionicons name="ribbon-outline" size={40} color={colors.textTertiary} />
            <Text variant="bodySmall" tone="secondary" align="center">
              {filter === 'earned' ? 'No badges earned yet — cook a meal or scan your fridge to start.' : 'Nothing in this view.'}
            </Text>
          </Card>
        }
      />

      {/* --- Badge detail ---------------------------------------------------- */}
      <Sheet
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.name}
        scrollable={false}
        testID="achievement-detail"
      >
        {selected ? (
          <View style={{ gap: spacing.lg, alignItems: 'center' }}>
            <View
              style={{
                width: 88,
                height: 88,
                borderRadius: radii.pill,
                backgroundColor: selected.earned ? colors.primarySoft : colors.divider,
                borderWidth: sizes.borderWidthThick,
                borderColor: selected.earned ? colors.primary : colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 40 }}>{selected.icon}</Text>
            </View>

            <Text variant="body" tone="secondary" align="center">
              {selected.description}
            </Text>

            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Chip label={humanize(selected.category)} size="sm" />
              {selected.target != null ? (
                <Chip label={`${selected.current}/${selected.target} ${selected.unit ?? ''}`.trim()} size="sm" selected />
              ) : null}
              {selected.tier ? <Chip label={`${humanize(selected.tier)} tier`} size="sm" /> : null}
            </View>

            {selected.earned && selected.earned_at ? (
              <Text variant="captionSmall" tone="success" align="center">
                Earned {new Date(selected.earned_at).toLocaleDateString()}
              </Text>
            ) : (
              <Text variant="captionSmall" tone="tertiary" align="center">
                {Math.max(0, (selected.target ?? 0) - selected.current)} more {selected.unit} to go
              </Text>
            )}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** Completion ratio, used to sort locked badges by "closest to unlocking". */
function progressOf(item: AchievementDto): number {
  if (item.earned) return Number.MAX_SAFE_INTEGER;
  if (item.progress != null) return item.progress;
  // `target` is null on one-shot badges ("first scan") that have no counter.
  const target = item.target ?? 0;
  return target > 0 ? item.current / target : 0;
}
