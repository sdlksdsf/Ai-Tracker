import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AchievementDto,
  AchievementsProgress,
  AuthSession,
  CheckoutRequest,
  CheckoutResponse,
  CompleteMealInput,
  CookRecipeInput,
  CreatePantryItemInput,
  CreateWasteLogInput,
  DashboardDto,
  ExpiringSoonItemDto,
  GenerateMealPlanInput,
  GenerateRecipesInput,
  GroceryListDto,
  HomeSummaryDto,
  ListNotificationsQuery,
  MealPlanDto,
  NotificationDto,
  NotificationPreferencesRequest,
  OnboardingRequest,
  PantryItemDto,
  PantryStatsDto,
  PriceComparisonDto,
  RecipeDto,
  SavingsStatsDto,
  ScanDto,
  ScanStatusDto,
  SearchRecipesQuery,
  SubscriptionStatus,
  SwapMealInput,
  UpdatePantryItemInput,
  UpdatePreferencesRequest,
  UpdateProfileInput,
  UserDto,
  WasteImpactDto,
  WasteStatsDto,
  WeekOverviewDto,
  WasteDto,
} from '@platematch/shared';
import { api } from '../lib/api.js';
import { cacheTimes, invalidationGroups, queryKeys } from '../lib/query.js';
import { toast } from '../stores/ui.store.js';
import { describeError } from '../lib/logger.js';

/**
 * Data-access hooks.
 *
 * One place that knows every endpoint the app calls, so screens never build a
 * URL or invalidate a cache key by hand. Each mutation declares the queries it
 * makes stale through `invalidationGroups`, which is what keeps the Home screen
 * honest after a pantry edit made three screens away.
 */

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.user,
    queryFn: () => api.get<UserDto>('/users/me'),
    staleTime: cacheTimes.volatile,
  });
}

export function useUpdateProfile() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateProfileInput) => api.patch<UserDto>('/users/me', input),
    onSuccess: (user) => {
      client.setQueryData(queryKeys.user, user);
      void invalidateAll(client, invalidationGroups.profileChanged);
      toast('Profile updated', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

/**
 * Dietary preferences, allergies and cooking constraints.
 *
 * Deliberately a different endpoint from `PATCH /users/me`: that route
 * validates against `updateProfileSchema`, and Zod strips keys it does not
 * know. Posting a diet or an allergy list there returns 200 and quietly throws
 * the data away — and allergies drive the recipe safety guard, so a dropped
 * write is not a cosmetic problem.
 */
export function useUpdatePreferences() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdatePreferencesRequest) => api.put<UserDto>('/users/me/preferences', input),
    onSuccess: (user) => {
      client.setQueryData(queryKeys.user, user);
      // `profileChanged` already covers allergies, targets and every recipe
      // query — changing an allergen must invalidate cached recipe results.
      void invalidateAll(client, invalidationGroups.profileChanged);
      toast('Preferences saved', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

/** Onboarding submit: preferences *and* profile fields, in one request. */
export function useCompleteOnboarding() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: OnboardingRequest) => api.post<UserDto>('/users/me/onboarding', input),
    onSuccess: (user) => {
      client.setQueryData(queryKeys.user, user);
      void invalidateAll(client, invalidationGroups.profileChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useSubscriptionStatus() {
  return useQuery({
    queryKey: queryKeys.subscriptionStatus,
    queryFn: () => api.get<SubscriptionStatus>('/subscription/status'),
    staleTime: cacheTimes.volatile,
  });
}

export function usePlans() {
  return useQuery({
    queryKey: queryKeys.plans,
    queryFn: () => api.get<{ prices: Array<Record<string, unknown>>; features: Array<Record<string, unknown>> }>('/subscription/plans', { anonymous: true }),
    staleTime: cacheTimes.static,
  });
}

export function useStartCheckout() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CheckoutRequest) => api.post<CheckoutResponse>('/subscription/checkout', input),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.subscriptionChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Dashboard / Home
// ---------------------------------------------------------------------------

export function useHomeSummary() {
  return useQuery({
    queryKey: queryKeys.home,
    queryFn: () => api.get<HomeSummaryDto>('/dashboard/home'),
    staleTime: cacheTimes.volatile,
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => api.get<DashboardDto>('/dashboard'),
    staleTime: cacheTimes.volatile,
  });
}

export function useSavings(period: 'week' | 'month' | 'year' = 'month') {
  return useQuery({
    queryKey: queryKeys.savings(period),
    queryFn: () => api.get<SavingsStatsDto>('/dashboard/savings', { query: { period } }),
    staleTime: cacheTimes.volatile,
  });
}

export function useExpiringSoon(days = 5) {
  return useQuery({
    queryKey: queryKeys.expiringSoon(days),
    queryFn: () => api.get<ExpiringSoonItemDto[]>('/dashboard/expiring-soon', { query: { days } }),
    staleTime: cacheTimes.volatile,
  });
}

export function useTrends(days = 30) {
  return useQuery({
    queryKey: queryKeys.trends(days),
    queryFn: () => api.get<Record<string, unknown>>('/dashboard/trends', { query: { days } }),
    staleTime: cacheTimes.volatile,
  });
}

// ---------------------------------------------------------------------------
// Pantry
// ---------------------------------------------------------------------------

export interface PantryFilters {
  category?: string;
  location?: string;
  expired?: boolean;
  used?: boolean;
  q?: string;
  sort?: 'expiry_date' | 'created_at' | 'name' | 'category';
  page?: number;
  limit?: number;
}

export function usePantry(filters: PantryFilters = {}) {
  // A named interface has no index signature, so widen it once, up front, and
  // use the same object for both the cache key and the query string.
  const query = filters as unknown as Record<string, string | number | boolean | undefined>;

  return useQuery({
    queryKey: queryKeys.pantry(query),
    queryFn: () => api.list<PantryItemDto>('/pantry', { query }),
    staleTime: cacheTimes.volatile,
  });
}

export function usePantryStats() {
  return useQuery({
    queryKey: queryKeys.pantryStats,
    queryFn: () => api.get<PantryStatsDto>('/pantry/stats'),
    staleTime: cacheTimes.volatile,
  });
}

export function useExpiredItems() {
  return useQuery({
    queryKey: queryKeys.pantryExpired,
    queryFn: () => api.get<PantryItemDto[]>('/pantry/expired'),
    staleTime: cacheTimes.volatile,
  });
}

export function useCreatePantryItem() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CreatePantryItemInput) => api.post<PantryItemDto>('/pantry', input),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.pantryChanged);
      toast('Added to your pantry', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useUpdatePantryItem() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePantryItemInput }) => api.patch<PantryItemDto>(`/pantry/${id}`, input),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.pantryChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useDeletePantryItem() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/pantry/${id}`),
    onSuccess: async (_data, id) => {
      client.setQueryData(queryKeys.pantryItem(id), undefined);
      await invalidateAll(client, invalidationGroups.pantryChanged);
      toast('Removed from your pantry', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useMarkPantryUsed() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.patch<PantryItemDto>(`/pantry/${id}`, { is_used: true }),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.pantryChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useBatchMarkUsed() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ updated: number }>('/pantry/batch-use', { ids }),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.pantryChanged);
      toast('Marked as used', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function useScanHistory(page = 1) {
  return useQuery({
    queryKey: [...queryKeys.scans, page],
    queryFn: () => api.list<ScanDto>('/scan', { query: { page, limit: 10 } }),
    staleTime: cacheTimes.volatile,
  });
}

export function useScanStatus(scanId: string | null) {
  return useQuery({
    queryKey: queryKeys.scanStatus(scanId ?? 'none'),
    queryFn: () => api.get<ScanStatusDto>(`/scan/status/${scanId}`),
    enabled: Boolean(scanId),
    // The screen polls this deliberately; react-query refetching on top of that
    // would double the request rate.
    refetchOnMount: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function useScanDetail(scanId: string | null) {
  return useQuery({
    queryKey: queryKeys.scan(scanId ?? 'none'),
    queryFn: () => api.get<ScanDto>(`/scan/${scanId}`),
    enabled: Boolean(scanId),
  });
}

/**
 * Upload a fridge photo.
 *
 * The server accepts `?wait=true` and returns the finished result inline, so on a
 * good connection there is no polling at all.
 */
export function useCreateScan() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ uri, wait }: { uri: string; wait?: boolean }) =>
      api.upload<{ scan_id: string; status: string; estimated_time_s: number; result: ScanStatusDto | null }>(
        '/scan/fridge',
        { uri, name: `scan-${Date.now()}.jpg`, type: 'image/jpeg' },
        {},
        { query: { wait: wait ?? false, source: 'camera' } },
      ),
    onSuccess: async () => {
      client.invalidateQueries({ queryKey: queryKeys.scans });
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useConfirmScan() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ scanId, payload }: { scanId: string; payload: Record<string, unknown> }) =>
      api.post<{ created: number }>(`/scan/${scanId}/confirm`, payload),
    onSuccess: async (result) => {
      await invalidateAll(client, invalidationGroups.scanConfirmed);
      toast(`${result.created} item${result.created === 1 ? '' : 's'} added to your pantry`, 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export function useRecipes(filters: Partial<SearchRecipesQuery> = {}) {
  return useQuery({
    queryKey: queryKeys.recipes(filters),
    queryFn: () => api.list<RecipeDto>('/recipes', { query: filters as Record<string, string | number | boolean> }),
    staleTime: cacheTimes.recipe,
  });
}

export function useRecipe(id: string | null) {
  return useQuery({
    queryKey: queryKeys.recipe(id ?? 'none'),
    queryFn: () => api.get<RecipeDto>(`/recipes/${id}`),
    enabled: Boolean(id),
    staleTime: cacheTimes.recipe,
  });
}

export function useTrendingRecipes(limit = 12) {
  return useQuery({
    queryKey: queryKeys.recipeTrending,
    queryFn: () => api.get<RecipeDto[]>('/recipes/trending', { query: { limit }, anonymous: true }),
    staleTime: cacheTimes.recipe,
  });
}

export function useFavoriteRecipes() {
  return useQuery({
    queryKey: queryKeys.recipeFavorites,
    queryFn: () => api.get<RecipeDto[]>('/recipes/favorites'),
    staleTime: cacheTimes.volatile,
  });
}

export function useCookHistory() {
  return useQuery({
    queryKey: queryKeys.recipeHistory,
    queryFn: () => api.get<RecipeDto[]>('/recipes/history'),
    staleTime: cacheTimes.volatile,
  });
}

export interface GenerateRecipesResult {
  recipes: RecipeDto[];
  ai_model_used: string;
  used_local_engine: boolean;
  generation_time_ms: number;
  safety_notes: string[];
  missing_ingredients: string[];
}

export function useGenerateRecipes() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: GenerateRecipesInput) =>
      api.post<GenerateRecipesResult>('/recipes/generate', input, { timeoutMs: 90_000 }),
    onSuccess: async (result, input) => {
      client.setQueryData(queryKeys.recipeGenerated(stableKey(input)), result.recipes);
      client.invalidateQueries({ queryKey: queryKeys.recipesAll });
      if (!result.recipes.length) {
        toast('No safe recipes matched those filters', 'warning');
      }
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useToggleFavorite() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      api.post<{ is_favorite: boolean }>(`/recipes/${id}/favorite`, { favorite }),
    onSuccess: async (result, variables) => {
      // Update the cached detail in place so the heart flips instantly.
      const cached = client.getQueryData<RecipeDto>(queryKeys.recipe(variables.id));
      if (cached) client.setQueryData(queryKeys.recipe(variables.id), { ...cached, is_favorite: result.is_favorite });
      client.invalidateQueries({ queryKey: queryKeys.recipeFavorites });
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useCookRecipe() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CookRecipeInput }) =>
      api.post<{ consumed: number; recipe: RecipeDto }>(`/recipes/${id}/cook`, input),
    onSuccess: async (result) => {
      await invalidateAll(client, invalidationGroups.cooked);
      toast(result.consumed > 0 ? `Cooked — ${result.consumed} pantry items used` : 'Marked as cooked', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useRateRecipe() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, rating, review_text: review }: { id: string; rating: number; review_text?: string }) =>
      api.post<{ rating_avg: number; rating_count: number }>(`/recipes/${id}/rate`, { rating, review_text: review }),
    onSuccess: async () => {
      client.invalidateQueries({ queryKey: queryKeys.recipesAll });
      toast('Thanks for the rating!', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useCookNow() {
  return useMutation({
    mutationFn: (pantryItemId: string) =>
      api.post<{ recipe: RecipeDto | null; reason: string | null }>(`/recipes/cook-now/${pantryItemId}`, {}),
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Meal plans
// ---------------------------------------------------------------------------

export function useWeekOverview(weekStart?: string) {
  return useQuery({
    queryKey: queryKeys.weekOverview(weekStart),
    queryFn: () => api.get<WeekOverviewDto>('/meal-plans/week', { query: weekStart ? { week_start: weekStart } : undefined }),
    staleTime: cacheTimes.volatile,
  });
}

export function useMealPlans() {
  return useQuery({
    queryKey: queryKeys.mealPlans,
    queryFn: () => api.get<MealPlanDto[]>('/meal-plans'),
    staleTime: cacheTimes.volatile,
  });
}

export function useMealPlan(id: string | null) {
  return useQuery({
    queryKey: queryKeys.mealPlan(id ?? 'none'),
    queryFn: () => api.get<MealPlanDto>(`/meal-plans/${id}`),
    enabled: Boolean(id),
    staleTime: cacheTimes.volatile,
  });
}

export function usePlanNutrition(id: string | null) {
  return useQuery({
    queryKey: queryKeys.mealPlanNutrition(id ?? 'none'),
    queryFn: () => api.get<Record<string, unknown>>(`/meal-plans/${id}/nutrition`),
    enabled: Boolean(id),
  });
}

export interface CreateMealPlanResult {
  meal_plan: MealPlanDto;
  grocery_list_id: string | null;
  ai_model_used: string;
  generation_time_ms: number;
  used_local_engine: boolean;
  nutrition_verification: {
    days_checked: number;
    days_within_tolerance: number;
    tolerance_pct: number;
    warnings: string[];
  };
}

export function useGenerateMealPlan() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: GenerateMealPlanInput) =>
      api.post<CreateMealPlanResult>('/meal-plans/generate', input, { timeoutMs: 120_000 }),
    onSuccess: async (result) => {
      client.setQueryData(queryKeys.mealPlan(result.meal_plan.id), result.meal_plan);
      await invalidateAll(client, invalidationGroups.planChanged);
      toast('Your week is planned', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useSwapMeal() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ planId, entryId, input }: { planId: string; entryId: string; input: SwapMealInput }) =>
      api.post<MealPlanDto>(`/meal-plans/${planId}/entries/${entryId}/swap`, input, { timeoutMs: 60_000 }),
    onSuccess: async (plan) => {
      client.setQueryData(queryKeys.mealPlan(plan.id), plan);
      await invalidateAll(client, invalidationGroups.planChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useCompleteMeal() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ planId, entryId, input }: { planId: string; entryId: string; input: CompleteMealInput }) =>
      api.post<MealPlanDto>(`/meal-plans/${planId}/entries/${entryId}/complete`, input),
    onSuccess: async (plan) => {
      client.setQueryData(queryKeys.mealPlan(plan.id), plan);
      await invalidateAll(client, invalidationGroups.cooked);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Grocery lists
// ---------------------------------------------------------------------------

export function useGroceryLists(status: 'active' | 'completed' | 'all' = 'all') {
  return useQuery({
    queryKey: [...queryKeys.groceryLists, status],
    queryFn: () => api.get<GroceryListDto[]>('/grocery-lists', { query: { status } }),
    staleTime: cacheTimes.volatile,
  });
}

export function useGroceryList(id: string | null) {
  return useQuery({
    queryKey: queryKeys.groceryList(id ?? 'none'),
    queryFn: () => api.get<GroceryListDto>(`/grocery-lists/${id}`),
    enabled: Boolean(id),
    staleTime: cacheTimes.volatile,
  });
}

export function useActiveGroceryList() {
  return useQuery({
    queryKey: queryKeys.groceryListActive,
    queryFn: () => api.get<GroceryListDto | null>('/grocery-lists/active'),
    staleTime: cacheTimes.volatile,
  });
}

export function useGenerateGroceryList() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<GroceryListDto>('/grocery-lists/generate', input, { timeoutMs: 60_000 }),
    onSuccess: async (list) => {
      client.setQueryData(queryKeys.groceryList(list.id), list);
      await invalidateAll(client, invalidationGroups.groceryChanged);
      toast(`List ready — ${list.total_count} items`, 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useToggleGroceryItem() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ listId, itemId, checked }: { listId: string; itemId: string; checked: boolean }) =>
      api.post(`/grocery-lists/${listId}/items/${itemId}/check`, { checked }),
    onSuccess: async (_data, variables) => {
      client.invalidateQueries({ queryKey: queryKeys.groceryList(variables.listId) });
      client.invalidateQueries({ queryKey: queryKeys.groceryListActive });
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useAddGroceryItem() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ listId, input }: { listId: string; input: Record<string, unknown> }) =>
      api.post(`/grocery-lists/${listId}/items`, input),
    onSuccess: async (_data, variables) => {
      client.invalidateQueries({ queryKey: queryKeys.groceryList(variables.listId) });
      await invalidateAll(client, invalidationGroups.groceryChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useComparePrices() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (listId: string) => api.post<PriceComparisonDto>(`/grocery-lists/${listId}/prices`, {}, { timeoutMs: 90_000 }),
    onSuccess: async (comparison, listId) => {
      client.setQueryData(queryKeys.groceryPrices(listId), comparison);
      client.invalidateQueries({ queryKey: queryKeys.groceryList(listId) });
      if (comparison.saved > 0) {
        toast(`You could save $${comparison.saved.toFixed(2)} at ${comparison.best_store ?? 'a cheaper store'}`, 'success');
      }
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useOrderHandoff() {
  return useMutation({
    mutationFn: ({ listId, provider }: { listId: string; provider: string }) =>
      api.post<{ url: string; share_text: string; item_count: number; estimated_total: number }>(
        `/grocery-lists/${listId}/order`,
        { provider, group_by: 'store' },
      ),
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Waste
// ---------------------------------------------------------------------------

export function useWasteLogs(filters: { period?: string; reason?: string; page?: number; limit?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.waste(filters),
    queryFn: () => api.list<WasteDto>('/waste', { query: filters as Record<string, string | number> }),
    staleTime: cacheTimes.volatile,
  });
}

export function useWasteStats(period: 'week' | 'month' | 'year' = 'week') {
  return useQuery({
    queryKey: queryKeys.wasteStats(period),
    queryFn: () => api.get<WasteStatsDto>('/waste/stats', { query: { period } }),
    staleTime: cacheTimes.volatile,
  });
}

export function useWasteImpact() {
  return useQuery({
    queryKey: queryKeys.wasteImpact,
    queryFn: () => api.get<WasteImpactDto>('/waste/impact'),
    staleTime: cacheTimes.volatile,
  });
}

export function useLogWaste() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateWasteLogInput) => api.post<WasteDto>('/waste', input),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.wasteChanged);
      toast('Logged — thanks for keeping the record honest', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

export function useDeleteWasteLog() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/waste/${id}`),
    onSuccess: async () => {
      await invalidateAll(client, invalidationGroups.wasteChanged);
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export function useAchievements() {
  return useQuery({
    queryKey: queryKeys.achievements,
    queryFn: () => api.get<AchievementDto[]>('/achievements'),
    staleTime: cacheTimes.volatile,
  });
}

export function useAchievementsProgress() {
  return useQuery({
    queryKey: queryKeys.achievementsProgress,
    queryFn: () => api.get<AchievementsProgress>('/achievements/progress'),
    staleTime: cacheTimes.volatile,
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function useNotifications(query: Partial<ListNotificationsQuery> = {}) {
  return useQuery({
    queryKey: queryKeys.notifications(query),
    queryFn: () => api.list<NotificationDto>('/notifications', { query: query as Record<string, string | number | boolean> }),
    staleTime: cacheTimes.volatile,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: queryKeys.notificationsUnread,
    queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationsRead() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (ids?: string[]) => api.post<{ updated: number }>('/notifications/read', ids ? { ids } : { all: true }),
    onSuccess: async () => {
      client.invalidateQueries({ queryKey: queryKeys.notificationsAll });
      client.invalidateQueries({ queryKey: queryKeys.notificationsUnread });
    },
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: queryKeys.notificationPreferences,
    queryFn: () => api.get<Record<string, unknown>>('/notifications/preferences'),
  });
}

export function useUpdateNotificationPreferences() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: NotificationPreferencesRequest) => api.put('/notifications/preferences', input),
    onSuccess: async (prefs) => {
      client.setQueryData(queryKeys.notificationPreferences, prefs);
      toast('Notification settings saved', 'success');
    },
    onError: (error) => toast(describeError(error), 'error'),
  });
}

// ---------------------------------------------------------------------------
// Auth mutations used by the auth screens
// ---------------------------------------------------------------------------

export function useLogin() {
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api.post<AuthSession>('/auth/login', input, { anonymous: true }),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (input: { email: string; password: string; full_name: string }) =>
      api.post<AuthSession>('/auth/register', input, { anonymous: true }),
  });
}

export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) => api.post<{ sent: boolean; message: string }>('/auth/forgot-password', { email }, { anonymous: true }),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Invalidate every key group in one await, so a mutation resolves after the UI can refetch. */
export async function invalidateAll(client: ReturnType<typeof useQueryClient>, groups: ReadonlyArray<readonly unknown[]>): Promise<void> {
  await Promise.all(groups.map((key) => client.invalidateQueries({ queryKey: key as unknown[] })));
}

/**
 * Stable cache key for a mutation input object.
 *
 * `JSON.stringify` is order-dependent, so two objects with the same fields in a
 * different order would produce different keys and duplicate cache entries.
 */
function stableKey(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input);
  const record = input as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join('&');
}
