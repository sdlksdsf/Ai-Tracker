import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import type { RecipeDto } from '@platematch/shared';
import { colors, radii, sizes, spacing } from '../theme/tokens.js';
import { Card } from './ui/Card.js';
import { Text } from './ui/Text.js';
import { Badge } from './ui/Badge.js';
import { ProgressBar } from './ui/Progress.js';

/**
 * Recipe card (Section 6, Screens 2 and 5).
 *
 * The pantry-match ring is the point of the card: PlateMatch ranks by "what you
 * can cook right now", so the percentage of ingredients already at home is the
 * first thing shown after the title.
 */

export interface RecipeCardProps {
  recipe: RecipeDto;
  onPress?: () => void;
  onFavorite?: () => void;
  /** Horizontal layout for list contexts, vertical for the discovery grid. */
  layout?: 'vertical' | 'horizontal';
  /** Hide the pantry match, e.g. in the public catalogue. */
  hideMatch?: boolean;
  testID?: string;
}

/** Time + difficulty + rating row. */
function MetaRow({ recipe }: { recipe: RecipeDto }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md }}>
      {recipe.total_time_min ? <Meta icon="time-outline" label={`${recipe.total_time_min} min`} /> : null}
      <Meta icon="restaurant-outline" label={`${recipe.servings} servings`} />
      {recipe.difficulty ? <Meta icon="speedometer-outline" label={capitalize(recipe.difficulty)} /> : null}
      {recipe.rating_count > 0 ? (
        <Meta icon="star" label={recipe.rating_avg.toFixed(1)} color={colors.warning} />
      ) : null}
    </View>
  );
}

function Meta({ icon, label, color }: { icon: keyof typeof Ionicons.glyphMap; label: string; color?: string }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Ionicons name={icon} size={sizes.iconXs} color={color ?? colors.textTertiary} />
      <Text variant="captionSmall" tone="tertiary">
        {label}
      </Text>
    </View>
  );
}

function MatchBadge({ recipe }: { recipe: RecipeDto }): React.ReactElement | null {
  const match = recipe.pantry_match;
  if (!match || match.total === 0) return null;

  const percent = Math.round(match.ratio * 100);
  // A recipe you can fully cook from the pantry is the whole value proposition,
  // so it gets the strongest treatment.
  const tone = percent >= 80 ? 'success' : percent >= 50 ? 'warning' : 'secondary';

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="checkmark-circle" size={sizes.iconSm} color={colors.primary} />
          <Text variant="caption" tone="secondary">
            {match.in_pantry}/{match.total} in your pantry
          </Text>
        </View>
        <Badge label={`${percent}%`} tone={tone} size="sm" />
      </View>
      <ProgressBar value={match.ratio} height={sizes.progressHeightSm} color={colors.primary} testID="recipe-match-bar" />
      {match.missing.length ? (
        <Text variant="captionSmall" tone="tertiary" numberOfLines={2}>
          Need: {match.missing.slice(0, 4).join(', ')}
          {match.missing.length > 4 ? ` +${match.missing.length - 4} more` : ''}
        </Text>
      ) : null}
    </View>
  );
}

export function RecipeCard({
  recipe,
  onPress,
  onFavorite,
  layout = 'vertical',
  hideMatch = false,
  testID,
}: RecipeCardProps): React.ReactElement {
  const image = recipe.image_url ? (
    <Image
      source={{ uri: recipe.image_url }}
      style={{
        width: layout === 'horizontal' ? sizes.thumbnailLg : '100%',
        height: layout === 'horizontal' ? sizes.thumbnailLg : sizes.cardImageHeight,
        backgroundColor: colors.skeleton,
      }}
      contentFit="cover"
      transition={220}
      // A blurred placeholder avoids a white flash while the CDN image loads.
      placeholder={{ blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH' }}
      accessibilityLabel={recipe.title}
    />
  ) : (
    <View
      style={{
        width: layout === 'horizontal' ? sizes.thumbnailLg : '100%',
        height: layout === 'horizontal' ? sizes.thumbnailLg : sizes.cardImageHeight,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name="fast-food-outline" size={layout === 'horizontal' ? sizes.iconLg : 40} color={colors.primary} />
    </View>
  );

  const favoriteButton = onFavorite ? (
    <View
      style={{
        position: layout === 'horizontal' ? undefined : 'absolute',
        top: layout === 'horizontal' ? undefined : spacing.sm,
        right: layout === 'horizontal' ? undefined : spacing.sm,
      }}
    >
      <Ionicons
        name={recipe.is_favorite ? 'heart' : 'heart-outline'}
        size={sizes.iconMd}
        color={recipe.is_favorite ? colors.danger : colors.textInverse}
      />
    </View>
  ) : null;

  if (layout === 'horizontal') {
    return (
      <Card onPress={onPress} flush testID={testID} accessibilityLabel={recipe.title}>
        <View style={{ flexDirection: 'row', gap: spacing.md, padding: spacing.md }}>
          <View style={{ borderRadius: radii.sm, overflow: 'hidden' }}>{image}</View>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="bodyMedium" numberOfLines={2}>
              {recipe.title}
            </Text>
            <MetaRow recipe={recipe} />
            {!hideMatch ? <MatchBadge recipe={recipe} /> : null}
          </View>
          {favoriteButton}
        </View>
      </Card>
    );
  }

  return (
    <Card onPress={onPress} flush elevated="level2" testID={testID} accessibilityLabel={recipe.title}>
      <View>
        <View>
          {image}
          {favoriteButton}

          {recipe.uses_expiring_items?.length ? (
            <View
              style={{
                position: 'absolute',
                left: spacing.sm,
                bottom: spacing.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: spacing.sm,
                paddingVertical: 3,
                borderRadius: radii.pill,
                backgroundColor: colors.secondary,
              }}
            >
              <Ionicons name="flame" size={11} color={colors.textInverse} />
              <Text variant="captionSmall" style={{ color: colors.textInverse }}>
                Uses {recipe.uses_expiring_items.length} expiring
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ padding: spacing.lg, gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <Text variant="headingSmall" style={{ flex: 1 }} numberOfLines={2}>
              {recipe.title}
            </Text>
            {recipe.is_cooked ? <Ionicons name="checkmark-done" size={sizes.iconSm} color={colors.success} /> : null}
          </View>

          <MetaRow recipe={recipe} />

          {!hideMatch ? <MatchBadge recipe={recipe} /> : null}

          {recipe.nutrition?.calories ? (
            <View style={{ flexDirection: 'row', gap: spacing.md, paddingTop: spacing.xs }}>
              <Nutrient label="kcal" value={Math.round(recipe.nutrition.calories)} />
              {/* Macros are nullable — a recipe can carry calories alone. */}
              <Nutrient label="protein" value={Math.round(recipe.nutrition.protein_g ?? 0)} unit="g" />
              <Nutrient label="carbs" value={Math.round(recipe.nutrition.carbs_g ?? 0)} unit="g" />
              <Nutrient label="fat" value={Math.round(recipe.nutrition.fat_g ?? 0)} unit="g" />
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

function Nutrient({ label, value, unit = '' }: { label: string; value: number; unit?: string }): React.ReactElement {
  return (
    <View style={{ alignItems: 'flex-start' }}>
      <Text variant="caption" tone="default">
        {value}
        {unit}
      </Text>
      <Text variant="captionSmall" tone="tertiary">
        {label}
      </Text>
    </View>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default RecipeCard;
