import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type { RecipeIngredient } from '@platematch/shared';
import { categoryIcon, colors, difficultyEmoji, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen, SectionHeader } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button, IconButton } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Chip } from '../../components/ui/Chip.js';
import { ProgressBar, MacroBar } from '../../components/ui/Progress.js';
import { Sheet } from '../../components/ui/Sheet.js';
import { ErrorState } from '../../components/ui/EmptyState.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { Input, QuantityStepper } from '../../components/ui/Input.js';
import { toast } from '../../stores/ui.store.js';
import { useCookRecipe, useRateRecipe, useRecipe, useToggleFavorite } from '../../hooks/useApi.js';
import { formatDuration, formatMoney, formatQuantityLabel, humanize } from '../../lib/format.js';

/**
 * Recipe detail (Section 6, Screen 6).
 *
 * The ingredient list is the working part of this screen, not decoration: each
 * line shows whether the user already has it, how much is in the pantry versus
 * how much the recipe needs, and what to use instead. Servings scale the
 * quantities live, because cooking for four from a two-serving recipe is the
 * normal case for a family.
 */

export default function RecipeDetailScreen(): React.ReactElement {
  const { t } = useTranslation('recipes');
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: recipe, isLoading, isError, error, refetch } = useRecipe(id ?? null);
  const toggleFavorite = useToggleFavorite();
  const cookRecipe = useCookRecipe();
  const rateRecipe = useRateRecipe();

  const [servings, setServings] = useState<number | null>(null);
  const [showRating, setShowRating] = useState(false);
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');
  const [showNutrition, setShowNutrition] = useState(false);

  const effectiveServings = servings ?? recipe?.servings ?? 2;
  const baseServings = recipe?.servings ?? 2;
  const scale = baseServings > 0 ? effectiveServings / baseServings : 1;

  const match = recipe?.pantry_match ?? null;
  const missing = useMemo(
    () => (recipe?.ingredients ?? []).filter((ingredient) => !ingredient.is_in_pantry && !ingredient.is_optional),
    [recipe?.ingredients],
  );

  if (isLoading) {
    return (
      <Screen header={{ title: '', back: true, onBack: () => router.back() }} testID="recipe-screen">
        <SkeletonList count={4} />
      </Screen>
    );
  }

  if (isError || !recipe) {
    return (
      <Screen header={{ title: '', back: true, onBack: () => router.back() }} testID="recipe-screen">
        <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const nutrition = recipe.nutrition ?? null;

  return (
    <Screen
      padding={false}
      testID="recipe-screen"
      header={undefined}
      contentStyle={{ paddingBottom: 0 }}
      footer={
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          {missing.length ? (
            <Button
              label={`Buy ${missing.length} item${missing.length === 1 ? '' : 's'}`}
              icon="cart-outline"
              variant="outline"
              onPress={() => router.push(`/grocery/new?recipe=${recipe.id}`)}
              style={{ flex: 1 }}
              testID="recipe-add-to-grocery"
            />
          ) : null}
          <Button
            label={t('startCooking')}
            icon="flame-outline"
            onPress={() => router.push(`/cooking/${recipe.id}`)}
            style={{ flex: 1 }}
            testID="recipe-start-cooking"
          />
        </View>
      }
    >
      {/* --- Hero ----------------------------------------------------------- */}
      {recipe.image_url ? (
        <Image
          source={{ uri: recipe.image_url }}
          style={{ width: '100%', height: sizes.heroImageHeight }}
          contentFit="cover"
          transition={250}
        />
      ) : (
        <View style={{ width: '100%', height: 140, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="fast-food-outline" size={48} color={colors.primary} />
        </View>
      )}

      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.lg }}>
        {/* Title row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }}>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="displaySmall">{recipe.title}</Text>
            {recipe.description ? (
              <Text variant="bodySmall" tone="secondary">
                {recipe.description}
              </Text>
            ) : null}
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            <IconButton
              icon={recipe.is_favorite ? 'heart' : 'heart-outline'}
              tone={recipe.is_favorite ? colors.danger : colors.textSecondary}
              onPress={() => void toggleFavorite.mutateAsync({ id: recipe.id, favorite: !recipe.is_favorite })}
              accessibilityLabel={recipe.is_favorite ? t('unfavorite') : t('favorite')}
              testID="recipe-favorite"
            />
            <IconButton
              icon="share-social-outline"
              onPress={() => toast('Sharing opens the native share sheet', 'info')}
              accessibilityLabel={t('share')}
            />
          </View>
        </View>

        {/* Meta */}
        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          {recipe.cuisine ? <Badge label={humanize(recipe.cuisine)} tone="accent" icon="globe-outline" /> : null}
          <Badge label={`${difficultyEmoji[recipe.difficulty] ?? ''} ${humanize(recipe.difficulty)}`} tone="neutral" />
          {recipe.total_time_min ? <Badge label={formatDuration(recipe.total_time_min)} tone="neutral" icon="time-outline" /> : null}
          {recipe.rating_count > 0 ? (
            <Badge label={`${recipe.rating_avg.toFixed(1)} (${recipe.rating_count})`} tone="warning" icon="star" />
          ) : null}
          {recipe.times_cooked > 0 ? <Badge label={`Cooked ${recipe.times_cooked}×`} tone="neutral" icon="flame-outline" /> : null}
        </View>

        {/* Allergen safety */}
        {recipe.allergen_warnings?.length ? (
          <Card padding="md" style={{ gap: spacing.sm, backgroundColor: colors.dangerSoft }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="warning" size={sizes.iconMd} color={colors.danger} />
              <Text variant="caption" tone="danger" style={{ flex: 1 }}>
                {t('allergenWarning')}
              </Text>
            </View>
            {recipe.allergen_warnings.map((warning) => (
              <Text key={warning} variant="captionSmall" tone="secondary">
                · {warning}
              </Text>
            ))}
          </Card>
        ) : null}

        {/* Pantry match */}
        {match && match.total > 0 ? (
          <Card padding="lg" style={{ gap: spacing.sm }} testID="recipe-pantry-match">
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Ionicons name={match.ratio >= 1 ? 'checkmark-circle' : 'basket-outline'} size={sizes.iconMd} color={match.ratio >= 1 ? colors.success : colors.primary} />
                <Text variant="bodyMedium">
                  {match.ratio >= 1 ? t('allInPantry') : t('pantryMatch', { count: match.in_pantry, total: match.total })}
                </Text>
              </View>
              <Text variant="statSmall" tone={match.ratio >= 0.8 ? 'success' : 'default'}>
                {Math.round(match.ratio * 100)}%
              </Text>
            </View>
            <ProgressBar value={match.ratio} color={match.ratio >= 0.8 ? colors.success : colors.primary} />
            {match.missing.length ? (
              <Text variant="captionSmall" tone="secondary">
                {t('missingIngredients')}: {match.missing.join(', ')}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {/* Nutrition summary */}
        {nutrition?.calories ? (
          <Card padding="lg" style={{ gap: spacing.md }} onPress={() => setShowNutrition(true)} testID="recipe-nutrition">
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text variant="headingSmall">{t('nutrition')}</Text>
              <Text variant="captionSmall" tone="tertiary">
                {t('perServing')} · tap for detail
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <NutrientValue label="Calories" value={String(Math.round(nutrition.calories))} unit="kcal" />
              <NutrientValue label="Protein" value={String(Math.round(nutrition.protein_g ?? 0))} unit="g" />
              <NutrientValue label="Carbs" value={String(Math.round(nutrition.carbs_g ?? 0))} unit="g" />
              <NutrientValue label="Fat" value={String(Math.round(nutrition.fat_g ?? 0))} unit="g" />
            </View>

            <MacroBar protein={nutrition.protein_g ?? 0} carbs={nutrition.carbs_g ?? 0} fat={nutrition.fat_g ?? 0} />
          </Card>
        ) : null}

        {/* Cost */}
        {recipe.total_cost_estimate ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Ionicons name="pricetag-outline" size={sizes.iconSm} color={colors.textTertiary} />
            <Text variant="caption" tone="secondary">
              About {formatMoney(recipe.total_cost_estimate)} for {baseServings} servings ·{' '}
              {formatMoney(recipe.total_cost_estimate / Math.max(1, baseServings))} each
            </Text>
          </View>
        ) : null}

        {/* Servings scaler */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
          <Text variant="headingSmall">{t('ingredients')}</Text>
          <QuantityStepper value={effectiveServings} onChange={setServings} min={1} max={12} step={1} suffix="servings" testID="recipe-servings" />
        </View>

        {/* Ingredients */}
        <Card flush testID="recipe-ingredients">
          {(recipe.ingredients ?? []).map((ingredient, index) => (
            <IngredientRow key={ingredient.id ?? `${ingredient.ingredient_name}-${index}`} ingredient={ingredient} scale={scale} />
          ))}
        </Card>

        {/* Method */}
        <View style={{ gap: spacing.md }}>
          <SectionHeader title={t('steps')} />
          {(recipe.steps ?? []).map((step) => (
            <Card key={step.id ?? step.step_number} padding="lg" style={{ flexDirection: 'row', gap: spacing.md }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radii.pill,
                  backgroundColor: colors.primarySoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text variant="caption" tone="primary">
                  {step.step_number}
                </Text>
              </View>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text variant="body">{step.instruction}</Text>
                {step.duration_min ? (
                  <Text variant="captionSmall" tone="tertiary">
                    ⏱ {step.duration_min} min
                  </Text>
                ) : null}
                {step.tip ? (
                  <View style={{ flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs }}>
                    <Ionicons name="bulb-outline" size={sizes.iconXs} color={colors.secondary} />
                    <Text variant="captionSmall" tone="secondary" style={{ flex: 1 }}>
                      {step.tip}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Card>
          ))}
        </View>

        {/* Storage + reheating */}
        {recipe.storage_instructions || recipe.reheating_instructions ? (
          <Card padding="lg" style={{ gap: spacing.md }}>
            {recipe.storage_instructions ? (
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Ionicons name="cube-outline" size={sizes.iconSm} color={colors.textTertiary} />
                <View style={{ flex: 1 }}>
                  <Text variant="caption" tone="secondary">
                    {t('storage')}
                  </Text>
                  <Text variant="bodySmall">{recipe.storage_instructions}</Text>
                </View>
              </View>
            ) : null}
            {recipe.reheating_instructions ? (
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Ionicons name="flame-outline" size={sizes.iconSm} color={colors.textTertiary} />
                <View style={{ flex: 1 }}>
                  <Text variant="caption" tone="secondary">
                    {t('reheating')}
                  </Text>
                  <Text variant="bodySmall">{recipe.reheating_instructions}</Text>
                </View>
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* Tags */}
        {recipe.tags?.length ? (
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {recipe.tags.map((tag) => (
              <Chip key={tag} label={humanize(tag)} size="sm" onPress={() => router.push(`/(tabs)/recipes?q=${encodeURIComponent(tag)}`)} />
            ))}
          </View>
        ) : null}

        {/* Actions */}
        <View style={{ gap: spacing.md }}>
          <Button
            label={t('markCooked')}
            icon="checkmark-done"
            variant="outline"
            loading={cookRecipe.isPending}
            onPress={async () => {
              const result = await cookRecipe.mutateAsync({
                id: recipe.id,
                input: { servings: effectiveServings, skip_ingredients: [], consume_pantry: true },
              });
              if (result.consumed > 0) router.push('/pantry');
            }}
            block
            testID="recipe-mark-cooked"
          />
          <Button label={t('ratingPrompt')} icon="star-outline" variant="ghost" onPress={() => { setRating(0); setReview(''); setShowRating(true); }} block />
        </View>

        <Text variant="captionSmall" tone="tertiary" align="center">
          Source: {humanize(recipe.source)} · {recipe.is_featured ? 'Featured' : null}
        </Text>
      </View>

      {/* --- Rating sheet --------------------------------------------------- */}
      <Sheet
        visible={showRating}
        onClose={() => setShowRating(false)}
        title={t('ratingPrompt')}
        subtitle={recipe.title}
        testID="recipe-rating"
        footer={
          <Button
            label={t('rateSubmit')}
            icon="send"
            disabled={rating === 0}
            loading={rateRecipe.isPending}
            onPress={async () => {
              await rateRecipe.mutateAsync({ id: recipe.id, rating, review_text: review.trim() || undefined });
              setShowRating(false);
            }}
            block
          />
        }
      >
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.sm }}>
          {[1, 2, 3, 4, 5].map((value) => (
            <Button
              key={value}
              label=""
              icon={value <= rating ? 'star' : 'star-outline'}
              variant="ghost"
              onPress={() => setRating(value)}
              accessibilityLabel={`${value} star${value === 1 ? '' : 's'}`}
              style={{ width: 48, height: 48 }}
            />
          ))}
        </View>

        <Input
          label="Review (optional)"
          value={review}
          onChangeText={setReview}
          placeholder="What worked? What would you change?"
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Sheet>

      {/* --- Nutrition detail ---------------------------------------------- */}
      <Sheet visible={showNutrition} onClose={() => setShowNutrition(false)} title={t('nutrition')} subtitle={`${t('perServing')} · ${baseServings} servings`} testID="recipe-nutrition-detail">
        {nutrition ? (
          <View style={{ gap: spacing.md }}>
            <MacroBar protein={nutrition.protein_g ?? 0} carbs={nutrition.carbs_g ?? 0} fat={nutrition.fat_g ?? 0} />
            {[
              ['Calories', nutrition.calories, 'kcal'],
              ['Protein', nutrition.protein_g, 'g'],
              ['Carbohydrates', nutrition.carbs_g, 'g'],
              ['Fat', nutrition.fat_g, 'g'],
              ['Fibre', nutrition.fiber_g, 'g'],
              ['Sugar', nutrition.sugar_g, 'g'],
              ['Saturated fat', nutrition.saturated_fat_g, 'g'],
              ['Cholesterol', nutrition.cholesterol_mg, 'mg'],
              ['Sodium', nutrition.sodium_mg, 'mg'],
              ['Potassium', nutrition.potassium_mg, 'mg'],
              ['Vitamin A', nutrition.vitamin_a_pct, '% DV'],
              ['Vitamin C', nutrition.vitamin_c_pct, '% DV'],
              ['Calcium', nutrition.calcium_pct, '% DV'],
              ['Iron', nutrition.iron_pct, '% DV'],
            ].map(([label, value, unit]) =>
              value == null ? null : (
                <View key={String(label)} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xs, borderBottomWidth: sizes.dividerHeight, borderBottomColor: colors.divider }}>
                  <Text variant="bodySmall" tone="secondary">
                    {label}
                  </Text>
                  <Text variant="bodySmall">
                    {Math.round(Number(value) * 10) / 10} {unit}
                  </Text>
                </View>
              ),
            )}
            <Text variant="captionSmall" tone="tertiary">
              Values are estimates from the ingredient list and should not be used for medical dietary management.
            </Text>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

function IngredientRow({ ingredient, scale }: { ingredient: RecipeIngredient; scale: number }): React.ReactElement {
  const scaledQuantity = ingredient.quantity != null ? Math.round(ingredient.quantity * scale * 100) / 100 : null;
  const have = ingredient.is_in_pantry;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: sizes.dividerHeight,
        borderBottomColor: colors.divider,
      }}
    >
      <Ionicons
        name={have ? 'checkmark-circle' : ingredient.is_optional ? 'remove-circle-outline' : 'ellipse-outline'}
        size={sizes.iconSm}
        color={have ? colors.success : ingredient.is_optional ? colors.textTertiary : colors.borderStrong}
      />

      <Text style={{ fontSize: 16 }}>{categoryIcon(ingredient.category ?? null)}</Text>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodySmall" tone={ingredient.is_optional ? 'tertiary' : 'default'}>
          {ingredient.ingredient_name}
          {ingredient.is_optional ? ' (optional)' : ''}
        </Text>

        {/* Tell the user how much they have versus how much the recipe needs —
            that is the difference between a list and a shopping decision. */}
        {have && ingredient.pantry_quantity != null && ingredient.quantity != null ? (
          <Text variant="captionSmall" tone={ingredient.pantry_quantity >= ingredient.quantity * scale ? 'success' : 'warning'}>
            You have {formatQuantityLabel(ingredient.pantry_quantity, ingredient.unit)} · need{' '}
            {formatQuantityLabel(ingredient.quantity * scale, ingredient.unit)}
          </Text>
        ) : null}

        {ingredient.substitutes?.length ? (
          <Text variant="captionSmall" tone="tertiary">
            Or: {ingredient.substitutes.join(', ')}
          </Text>
        ) : null}
      </View>

      {scaledQuantity != null ? (
        <Text variant="caption" style={{ minWidth: 72, textAlign: 'right' }}>
          {formatQuantityLabel(scaledQuantity, ingredient.unit)}
        </Text>
      ) : (
        <Text variant="captionSmall" tone="tertiary" style={{ minWidth: 72, textAlign: 'right' }}>
          to taste
        </Text>
      )}
    </View>
  );
}

function NutrientValue({ label, value, unit }: { label: string; value: string; unit: string }): React.ReactElement {
  return (
    <View style={{ flex: 1, gap: 1 }}>
      <Text variant="statSmall">{value}</Text>
      <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
        {label} ({unit})
      </Text>
    </View>
  );
}
