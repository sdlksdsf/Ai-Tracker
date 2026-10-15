import React from 'react';
import { Pressable, View } from 'react-native';
import { colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Card } from './ui/Card.js';
import { Text } from './ui/Text.js';
import { Badge } from './ui/Badge.js';
import { ProgressBar } from './ui/Progress.js';
import type { AchievementDto } from '@platematch/shared';

/**
 * Achievement badge (Section 6, Screen 13).
 *
 * Locked badges still render their progress — seeing "18/20 recipes cooked" is
 * what makes someone cook two more. A hidden badge is not a motivator.
 */

export interface AchievementCardProps {
  achievement: AchievementDto;
  onPress?: () => void;
  /** Grid layout (3-up) rather than a full-width row. */
  compact?: boolean;
  testID?: string;
}

const CATEGORY_TONES: Record<string, { bg: string; fg: string }> = {
  scanning: { bg: colors.accentSoft, fg: colors.accent },
  cooking: { bg: colors.primarySoft, fg: colors.primary },
  waste: { bg: colors.warningSoft, fg: colors.warning },
  savings: { bg: colors.successSoft, fg: colors.success },
  streak: { bg: colors.secondarySoft, fg: colors.secondary },
  planning: { bg: colors.accentSoft, fg: colors.accent },
  social: { bg: colors.divider, fg: colors.textSecondary },
};

export function AchievementCard({ achievement, onPress, compact = false, testID }: AchievementCardProps): React.ReactElement {
  const earned = achievement.earned;
  const tone = CATEGORY_TONES[achievement.category] ?? CATEGORY_TONES.social!;
  // One-shot badges carry no numeric target; treat a missing target as "no bar".
  const target = achievement.target ?? 0;
  const progress = target > 0 ? Math.min(1, achievement.current / target) : earned ? 1 : 0;

  const body = (
    <View style={{ gap: compact ? spacing.xs : spacing.sm, alignItems: compact ? 'center' : 'flex-start' }}>
      {/* Badge */}
      <View
        style={{
          width: compact ? 56 : 64,
          height: compact ? 56 : 64,
          borderRadius: radii.pill,
          backgroundColor: earned ? tone.bg : colors.divider,
          borderWidth: sizes.borderWidthThick,
          borderColor: earned ? tone.fg : colors.border,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: earned ? 1 : 0.6,
        }}
      >
        <Text style={{ fontSize: compact ? 24 : 28 }}>{achievement.icon}</Text>
      </View>

      <View style={{ gap: 2, alignItems: compact ? 'center' : 'flex-start', flex: compact ? undefined : 1 }}>
        <Text
          variant={compact ? 'caption' : 'bodyMedium'}
          align={compact ? 'center' : 'left'}
          numberOfLines={compact ? 2 : 1}
          tone={earned ? 'default' : 'secondary'}
        >
          {achievement.name}
        </Text>

        {!compact ? (
          <Text variant="captionSmall" tone="tertiary" numberOfLines={2}>
            {achievement.description}
          </Text>
        ) : null}
      </View>

      {/* Progress */}
      {!earned && target > 0 ? (
        <View style={{ width: '100%', gap: 4 }}>
          <ProgressBar
            value={progress}
            color={tone.fg}
            height={compact ? sizes.progressHeightSm : sizes.progressHeight}
            testID={testID ? `${testID}-progress` : undefined}
          />
          <Text variant="captionSmall" tone="tertiary" align={compact ? 'center' : 'left'}>
            {achievement.current}/{target} {achievement.unit}
          </Text>
        </View>
      ) : null}

      {earned ? (
        compact ? (
          <Badge label="Earned" tone="success" size="sm" />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Badge label="Earned" tone="success" size="sm" icon="checkmark-circle" />
            <Badge label={`+${achievement.points} pts`} tone="primary" size="sm" />
            {achievement.tier ? (
              <Badge label={achievement.tier} tone="warning" size="sm" />
            ) : null}
          </View>
        )
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <Card padding={compact ? 'md' : 'lg'} testID={testID} style={compact ? { width: 132 } : undefined}>
        {body}
      </Card>
    );
  }

  return (
    <Card onPress={onPress} padding={compact ? 'md' : 'lg'} testID={testID} style={compact ? { width: 132 } : undefined} accessibilityLabel={`${achievement.name}${earned ? ', earned' : `, ${achievement.current} of ${achievement.target}`}`}>
      {body}
    </Card>
  );
}

/** Level header shown at the top of the achievements screen. */
export function LevelCard({
  level,
  levelLabel,
  points,
  nextLevelPoints,
  streakDays,
  earned,
  total,
  onPress,
  testID,
}: {
  level: number;
  levelLabel: string;
  points: number;
  nextLevelPoints: number;
  streakDays: number;
  earned: number;
  total: number;
  onPress?: () => void;
  testID?: string;
}): React.ReactElement {
  const progress = nextLevelPoints > 0 ? Math.min(1, points / nextLevelPoints) : 1;
  const remaining = Math.max(0, nextLevelPoints - points);

  return (
    <Card onPress={onPress} padding="xl" testID={testID} style={{ gap: spacing.md, backgroundColor: colors.primary }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Text variant="caption" style={{ color: 'rgba(255,255,255,0.75)' }}>
            Level {level}
          </Text>
          <Text variant="displaySmall" style={{ color: colors.textInverse }}>
            {levelLabel}
          </Text>
        </View>

        {streakDays > 0 ? (
          <View
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              borderRadius: radii.md,
              backgroundColor: 'rgba(255,255,255,0.18)',
              alignItems: 'center',
            }}
          >
            <Text style={{ fontSize: 20 }}>🔥</Text>
            <Text variant="caption" style={{ color: colors.textInverse }}>
              {streakDays} day{streakDays === 1 ? '' : 's'}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={{ gap: 6 }}>
        <ProgressBar value={progress} color={colors.textInverse} trackColor="rgba(255,255,255,0.25)" testID={testID ? `${testID}-progress` : undefined} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="captionSmall" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {points} pts
          </Text>
          <Text variant="captionSmall" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {remaining > 0 ? `${remaining} to level ${level + 1}` : 'Max level'}
          </Text>
        </View>
      </View>

      <Text variant="captionSmall" style={{ color: 'rgba(255,255,255,0.75)' }}>
        {earned} of {total} badges earned
      </Text>
    </Card>
  );
}

export default AchievementCard;
