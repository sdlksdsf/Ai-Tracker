import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import {
  CUISINES,
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
  MEAL_TYPES,
  type MealType,
  type SearchRecipesQuery,
} from '@platematch/shared';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { Chip } from '../../components/ui/Chip.js';
import { Input, SelectField } from '../../components/ui/Input.js';
import { Sheet, OptionSheet, type SheetOption } from '../../components/ui/Sheet.js';
import { RecipeCard } from '../../components/RecipeCard.js';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState.js';
import { RecipeCardSkeleton } from '../../components/ui/Skeleton.js';
import { useDebouncedValue } from '../../hooks/index.js';
import { useGenerateRecipes, useRecipes } from '../../hooks/useApi.js';
import { useUiStore } from '../../stores/ui.store.js';
import { humanize } from '../../lib/format.js';

/**
 * Recipes (Section 6, Screen 5).
 *
 * Two entry points share one list: search/filter the public catalogue, or ask the
 * AI to generate from the pantry. Generation is the hero action because it is the
 * thing PlateMatch does that a recipe site cannot — it knows what is in the fridge
 * and what is about to expire.
 */

type SortKey = NonNullable<SearchRecipesQuery['sort']>;

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'best_match', label: 'Best match' },
  { value: 'fewest_missing', label: 'Fewest missing' },
  { value: 'quickest', label: 'Quickest' },
  { value: 'highest_rated', label: 'Highest rated' },
  { value: 'newest', label: 'Newest' },
];

export default function RecipesScreen(): React.ReactElement {
  const { t } = useTranslation('recipes');
  const router = useRouter();
  const setBusy = useUiStore((state) => state.setBusy);

  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);

  const [cuisine, setCuisine] = useState<string | undefined>();
  const [mealType, setMealType] = useState<MealType | undefined>();
  const [difficulty, setDifficulty] = useState<DifficultyLevel | undefined>();
  const [maxTime, setMaxTime] = useState<number | undefined>();
  const [sort, setSort] = useState<SortKey>('best_match');
  const [sortSheet, setSortSheet] = useState(false);
  const [cuisineSheet, setCuisineSheet] = useState(false);
  const [mealSheet, setMealSheet] = useState(false);
  const [difficultySheet, setDifficultySheet] = useState(false);

  // Generation options
  const [usePantry, setUsePantry] = useState(true);
  const [count, setCount] = useState(5);
  const [servings, setServings] = useState(2);
  const [extraIngredients, setExtraIngredients] = useState('');
  const [avoid, setAvoid] = useState('');

  const debouncedSearch = useDebouncedValue(search, 400);

  // Declared above `filters` on purpose: the memo reads `page`, and a `const`
  // is in the temporal dead zone until its own declaration is evaluated.
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      cuisine,
      meal_type: mealType,
      difficulty,
      maxTime,
      sort,
      // `buildQuery` serialises booleans to 'true'/'false', which is exactly
      // what the API's `use_pantry` enum expects — so send a real boolean.
      use_pantry: sort === 'best_match' || sort === 'fewest_missing',
      limit: 20,
      page,
    }),
    [debouncedSearch, cuisine, mealType, difficulty, maxTime, sort, page],
  );

  const { data, isLoading, isError, error, refetch, isRefetching } = useRecipes(filters);
  const generate = useGenerateRecipes();

  const recipes = useMemo(() => data?.items ?? [], [data]);
  const loadingMore = false;

  const loadMore = (): void => {
    setPage((current) => current + 1);
    void refetch();
  };

  const activeFilterCount = [cuisine, mealType, difficulty, maxTime].filter(Boolean).length;

  const handleGenerate = async (): Promise<void> => {
    setBusy(true, t('regenerating'));

    try {
      const result = await generate.mutateAsync({
        use_pantry: usePantry,
        extra_ingredients: splitList(extraIngredients),
        avoid: splitList(avoid),
        cuisine,
        meal_type: mealType as SearchRecipesQuery['meal_type'],
        difficulty: difficulty as SearchRecipesQuery['difficulty'],
        max_time_min: maxTime,
        servings,
        count,
        min_pantry_match: 0.3,
      });

      if (result.safety_notes?.length) {
        // The allergen guard rejected something — the user should know why the
        // count came back lower than they asked for.
        console.info('Allergen guard notes', result.safety_notes);
      }

      setShowGenerate(false);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  // Changing any filter must restart at page 1.
  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, cuisine, mealType, difficulty, maxTime, sort]);

  const clearFilters = (): void => {
    setCuisine(undefined);
    setMealType(undefined);
    setDifficulty(undefined);
    setMaxTime(undefined);
    setSearch('');
  };

  const sortOptions: Array<SheetOption<string>> = SORTS.map((option) => ({ value: option.value, label: option.label }));
  const cuisineOptions: Array<SheetOption<string>> = [
    { value: '', label: 'Any cuisine' },
    ...CUISINES.map((value) => ({ value, label: humanize(value) })),
  ];
  const mealOptions: Array<SheetOption<MealType | ''>> = [
    { value: '', label: 'Any meal' },
    ...MEAL_TYPES.map((value) => ({ value, label: humanize(value) })),
  ];
  const difficultyOptions: Array<SheetOption<DifficultyLevel | ''>> = [
    { value: '', label: 'Any difficulty' },
    ...DIFFICULTY_LEVELS.map((value) => ({ value, label: humanize(value) })),
  ];

  return (
    <Screen
      header={{
        title: t('title'),
        large: true,
        right: (
          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            <Button
              label=""
              icon={activeFilterCount ? 'filter' : 'options-outline'}
              variant="ghost"
              onPress={() => setShowFilters(true)}
              accessibilityLabel={`${t('filters')}${activeFilterCount ? `, ${activeFilterCount} active` : ''}`}
            />
            <Button label="" icon="sparkles" variant="ghost" onPress={() => setShowGenerate(true)} accessibilityLabel={t('generate')} testID="recipes-generate-open" />
          </View>
        ),
      }}
      padding={false}
      testID="recipes-screen"
    >
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder={t('searchPlaceholder')}
          icon="search-outline"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="recipes-search"
          rightAccessory={
            search.length ? (
              <Button label="" icon="close-circle" variant="ghost" size="sm" onPress={() => setSearch('')} accessibilityLabel="Clear search" />
            ) : undefined
          }
        />

        {/* Active filter chips */}
        {activeFilterCount > 0 ? (
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {cuisine ? <Chip label={humanize(cuisine)} selected size="sm" onRemove={() => setCuisine(undefined)} /> : null}
            {mealType ? <Chip label={humanize(mealType)} selected size="sm" onRemove={() => setMealType(undefined)} /> : null}
            {difficulty ? <Chip label={humanize(difficulty)} selected size="sm" onRemove={() => setDifficulty(undefined)} /> : null}
            {maxTime ? <Chip label={`≤ ${maxTime} min`} selected size="sm" onRemove={() => setMaxTime(undefined)} /> : null}
            <Chip label="Clear all" size="sm" onPress={clearFilters} />
          </View>
        ) : null}

        {/* Generate hero */}
        <Card onPress={() => setShowGenerate(true)} padding="lg" style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.primarySoft }} testID="recipes-generate-hero">
          <View style={{ width: 44, height: 44, borderRadius: radii.pill, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="sparkles" size={sizes.iconMd} color={colors.textInverse} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" tone="primary">
              {t('generateTitle')}
            </Text>
            <Text variant="captionSmall" tone="secondary">
              {t('generateSubtitle')}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.primary} />
        </Card>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="caption" tone="secondary">
            {isLoading ? t('common:loading', { ns: 'common' }) : `${data?.total ?? recipes.length} recipes`}
          </Text>
          <Chip label={`Sort: ${SORTS.find((option) => option.value === sort)?.label ?? 'Best match'}`} size="sm" icon="swap-vertical" onPress={() => setSortSheet(true)} />
        </View>
      </View>

      {isError && !recipes.length ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <ErrorState message={(error as Error)?.message} onRetry={() => void refetch()} />
        </View>
      ) : (
        <FlatList
          data={recipes}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.huge * 2, gap: spacing.md }}
          renderItem={({ item }) => (
            <RecipeCard recipe={item} onPress={() => router.push(`/recipe/${item.id}`)} testID={`recipe-${item.id}`} />
          )}
          refreshControl={<RefreshControl refreshing={isRefetching && !isLoading} onRefresh={() => void refetch()} tintColor={colors.primary} colors={[colors.primary]} />}
          // The catalogue is offset-paginated; page 2 is fetched on demand from
          // the "Load more" footer rather than silently on scroll, so a long list
          // cannot issue a request the user never sees.
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            data?.hasMore ? (
              <Button
                label={t('common:loading', { ns: 'common' }) === 'Loading…' ? 'Load more recipes' : 'Load more'}
                variant="ghost"
                onPress={() => void loadMore()}
                loading={loadingMore}
                testID="recipes-load-more"
              />
            ) : recipes.length ? (
              <Text variant="captionSmall" tone="tertiary" align="center" style={{ paddingVertical: spacing.lg }}>
                That is everything — {data?.total ?? recipes.length} recipes
              </Text>
            ) : null
          }
          ListEmptyComponent={
            isLoading ? (
              <View style={{ gap: spacing.md }}>
                {[0, 1, 2].map((index) => (
                  <RecipeCardSkeleton key={index} />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="search-outline"
                title={t('emptyTitle')}
                description={t('emptyBody')}
                actionLabel={t('generate')}
                onAction={() => setShowGenerate(true)}
                secondaryLabel="Clear filters"
                onSecondary={clearFilters}
                testID="recipes-empty"
              />
            )
          }
        />
      )}

      {/* --- Filters sheet -------------------------------------------------- */}
      <Sheet
        visible={showFilters}
        onClose={() => setShowFilters(false)}
        title={t('filters')}
        testID="recipes-filters"
        footer={
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button label="Clear" variant="ghost" onPress={clearFilters} style={{ flex: 1 }} />
            <Button label="Show recipes" onPress={() => setShowFilters(false)} style={{ flex: 2 }} />
          </View>
        }
      >
        <SelectField label={t('sortBy')} value={SORTS.find((option) => option.value === sort)?.label} onPress={() => setSortSheet(true)} icon="swap-vertical" />
        <SelectField label={t('filterCuisine')} value={cuisine ? humanize(cuisine) : undefined} placeholder="Any cuisine" onPress={() => setCuisineSheet(true)} icon="globe-outline" />
        <SelectField label={t('filterMealType')} value={mealType ? humanize(mealType) : undefined} placeholder="Any meal" onPress={() => setMealSheet(true)} icon="restaurant-outline" />
        <SelectField label={t('filterDifficulty')} value={difficulty ? humanize(difficulty) : undefined} placeholder="Any difficulty" onPress={() => setDifficultySheet(true)} icon="speedometer-outline" />

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('filterMaxTime')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {[undefined, 15, 30, 45, 60].map((minutes) => (
              <Chip
                key={String(minutes)}
                label={minutes ? `${minutes} min` : 'Any'}
                selected={maxTime === minutes}
                onPress={() => setMaxTime(minutes)}
              />
            ))}
          </View>
        </View>
      </Sheet>

      {/* --- Generate sheet ------------------------------------------------- */}
      <Sheet
        visible={showGenerate}
        onClose={() => setShowGenerate(false)}
        title={t('generateTitle')}
        subtitle={t('generateSubtitle')}
        testID="recipes-generate"
        footer={
          <Button
            label={generate.isPending ? t('regenerating') : t('generate')}
            icon="sparkles"
            onPress={() => void handleGenerate()}
            loading={generate.isPending}
            block
            size="lg"
          />
        }
      >
        <Chip
          label="Use my pantry"
          icon={usePantry ? 'checkmark-circle' : 'ellipse-outline'}
          selected={usePantry}
          onPress={() => setUsePantry((value) => !value)}
        />
        <Text variant="captionSmall" tone="tertiary">
          Recipes are ranked by how much of your pantry they use, and anything about to expire is prioritised.
        </Text>

        <Input
          label="Ingredients to add (optional)"
          value={extraIngredients}
          onChangeText={setExtraIngredients}
          placeholder="e.g. coconut milk, lime"
          hint="Things you are happy to buy on top of the pantry."
          icon="add-circle-outline"
        />

        <Input
          label="Avoid (optional)"
          value={avoid}
          onChangeText={setAvoid}
          placeholder="e.g. coriander, mushrooms"
          hint="On top of your declared allergies, which are always enforced."
          icon="ban-outline"
        />

        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="caption" tone="secondary">
              How many?
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {[3, 5, 8].map((value) => (
                <Chip key={value} label={String(value)} selected={count === value} onPress={() => setCount(value)} size="sm" />
              ))}
            </View>
          </View>

          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="caption" tone="secondary">
              {t('common:servings', { ns: 'common', count: servings })}
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {[1, 2, 4, 6].map((value) => (
                <Chip key={value} label={String(value)} selected={servings === value} onPress={() => setServings(value)} size="sm" />
              ))}
            </View>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.warningSoft }}>
          <Ionicons name="shield-checkmark-outline" size={sizes.iconSm} color={colors.warning} />
          <Text variant="captionSmall" tone="secondary" style={{ flex: 1 }}>
            Every result is re-checked against your allergies before it is shown. Unsafe recipes are removed entirely, so you may get fewer than you asked for.
          </Text>
        </View>
      </Sheet>

      <OptionSheet visible={sortSheet} onClose={() => setSortSheet(false)} onSelect={(value) => setSort(value as SortKey)} options={sortOptions} selected={sort} title={t('sortBy')} />
      <OptionSheet visible={cuisineSheet} onClose={() => setCuisineSheet(false)} onSelect={(value) => setCuisine(value || undefined)} options={cuisineOptions} selected={cuisine ?? ''} title={t('filterCuisine')} />
      <OptionSheet visible={mealSheet} onClose={() => setMealSheet(false)} onSelect={(value) => setMealType(value || undefined)} options={mealOptions} selected={mealType ?? ''} title={t('filterMealType')} />
      <OptionSheet visible={difficultySheet} onClose={() => setDifficultySheet(false)} onSelect={(value) => setDifficulty(value || undefined)} options={difficultyOptions} selected={difficulty ?? ''} title={t('filterDifficulty')} />
    </Screen>
  );
}

/** Split a comma-separated input into trimmed, de-duplicated entries. */
function splitList(raw: string): string[] {
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
}
