import { QueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError } from './api.js';

/**
 * TanStack Query setup.
 *
 * Cache times are tuned for how this app is actually used: the Home screen is
 * opened constantly and should feel instant, while an AI-generated recipe is
 * expensive to reproduce and worth keeping for a day.
 *
 * `retry` is deliberately selective. Retrying a 401 would fight the token
 * refresh, and retrying a 422 would just repeat a validation failure the user
 * has to fix — so only network errors and 5xx are retried.
 */

/** Query keys, centralised so invalidation cannot typo a string. */
export const queryKeys = {
  home: ['home'] as const,
  dashboard: ['dashboard'] as const,
  savings: (period: string) => ['savings', period] as const,
  weeklyReport: ['weekly-report'] as const,
  trends: (days: number) => ['trends', days] as const,
  expiringSoon: (days: number) => ['expiring-soon', days] as const,

  user: ['user', 'me'] as const,
  userPreferences: ['user', 'preferences'] as const,
  userAllergies: ['user', 'allergies'] as const,
  userSubscription: ['user', 'subscription'] as const,
  userTargets: ['user', 'nutrition-targets'] as const,

  pantry: (filters?: Record<string, unknown>) => ['pantry', filters ?? {}] as const,
  pantryAll: ['pantry'] as const,
  pantryItem: (id: string) => ['pantry', 'item', id] as const,
  pantryStats: ['pantry', 'stats'] as const,
  pantryExpired: ['pantry', 'expired'] as const,

  scans: ['scans'] as const,
  scan: (id: string) => ['scans', id] as const,
  scanStatus: (id: string) => ['scans', id, 'status'] as const,

  recipes: (filters?: Record<string, unknown>) => ['recipes', filters ?? {}] as const,
  recipesAll: ['recipes'] as const,
  recipe: (id: string) => ['recipes', id] as const,
  recipeRatings: (id: string) => ['recipes', id, 'ratings'] as const,
  recipeFavorites: ['recipes', 'favorites'] as const,
  recipeHistory: ['recipes', 'history'] as const,
  recipeTrending: ['recipes', 'trending'] as const,
  recipeGenerated: (key: string) => ['recipes', 'generated', key] as const,

  mealPlans: ['meal-plans'] as const,
  mealPlan: (id: string) => ['meal-plans', id] as const,
  mealPlanDays: (id: string) => ['meal-plans', id, 'days'] as const,
  mealPlanNutrition: (id: string) => ['meal-plans', id, 'nutrition'] as const,
  weekOverview: (weekStart?: string) => ['meal-plans', 'week', weekStart ?? 'current'] as const,

  groceryLists: ['grocery-lists'] as const,
  groceryList: (id: string) => ['grocery-lists', id] as const,
  groceryListActive: ['grocery-lists', 'active'] as const,
  groceryPrices: (id: string) => ['grocery-lists', id, 'prices'] as const,

  waste: (filters?: Record<string, unknown>) => ['waste', filters ?? {}] as const,
  wasteAll: ['waste'] as const,
  wasteStats: (period: string) => ['waste', 'stats', period] as const,
  wasteImpact: ['waste', 'impact'] as const,
  wasteStreak: ['waste', 'streak'] as const,

  achievements: ['achievements'] as const,
  achievementsProgress: ['achievements', 'progress'] as const,

  notifications: (filters?: Record<string, unknown>) => ['notifications', filters ?? {}] as const,
  notificationsAll: ['notifications'] as const,
  notificationsUnread: ['notifications', 'unread-count'] as const,
  notificationPreferences: ['notifications', 'preferences'] as const,

  plans: ['subscription', 'plans'] as const,
  subscriptionStatus: ['subscription', 'status'] as const,
} as const;

/** Groups of keys invalidated together after a mutation. */
export const invalidationGroups = {
  /** A pantry write changes expiry, Home, stats and every recipe ranking. */
  pantryChanged: [queryKeys.pantryAll, queryKeys.pantryStats, queryKeys.pantryExpired, queryKeys.home, queryKeys.dashboard, queryKeys.expiringSoon(3), queryKeys.recipesAll] as const,

  /** A completed scan adds pantry candidates and updates the Home screen. */
  scanCompleted: [queryKeys.scans, queryKeys.pantryAll, queryKeys.home, queryKeys.dashboard] as const,

  /** Confirming a scan writes real pantry rows. */
  scanConfirmed: [queryKeys.scan(''), queryKeys.pantryAll, queryKeys.pantryStats, queryKeys.home, queryKeys.dashboard, queryKeys.recipesAll] as const,

  /** Cooking consumes pantry items and moves achievement counters. */
  cooked: [queryKeys.pantryAll, queryKeys.pantryStats, queryKeys.recipesAll, queryKeys.recipeHistory, queryKeys.achievements, queryKeys.home, queryKeys.dashboard, queryKeys.wasteAll] as const,

  /** A plan or entry change reshapes the week and its grocery list. */
  planChanged: [queryKeys.mealPlans, queryKeys.weekOverview(), queryKeys.groceryLists, queryKeys.groceryListActive, queryKeys.home, queryKeys.dashboard] as const,

  /** Any grocery-list mutation changes the list, its totals and Home. */
  groceryChanged: [queryKeys.groceryLists, queryKeys.groceryListActive, queryKeys.home, queryKeys.dashboard] as const,

  /** Logging waste moves the savings and impact numbers. */
  wasteChanged: [queryKeys.wasteAll, queryKeys.wasteImpact, queryKeys.wasteStreak, queryKeys.home, queryKeys.dashboard, queryKeys.achievements, queryKeys.pantryAll] as const,

  /** Profile/preference changes affect targets, plans and personalisation. */
  profileChanged: [queryKeys.user, queryKeys.userPreferences, queryKeys.userAllergies, queryKeys.userTargets, queryKeys.home, queryKeys.recipesAll, queryKeys.weekOverview()] as const,

  /** A tier change re-gates features everywhere. */
  subscriptionChanged: [queryKeys.userSubscription, queryKeys.subscriptionStatus, queryKeys.user] as const,

  achievementsChanged: [queryKeys.achievements, queryKeys.achievementsProgress, queryKeys.home, queryKeys.dashboard] as const,
} as const;

function shouldRetry(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) {
    // Never retry a client error: it needs a user action, not another attempt.
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 10 * 60_000,
        retry: (failureCount, error) => shouldRetry(error) && failureCount < 2,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        refetchOnMount: true,
        // Keep previously rendered data while a filter changes, so the list does
        // not flash empty between pages.
        placeholderData: (previous: unknown) => previous,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** Longer cache budget for data that is expensive to reproduce. */
export const cacheTimes = {
  /** AI generation results — costly and stable. */
  generated: 24 * 60 * 60_000,
  /** Public recipe detail. */
  recipe: 6 * 60 * 60_000,
  /** Pricing table and plan limits — change rarely. */
  static: 12 * 60 * 60_000,
  /** Home/dashboard — refreshed on focus and after every mutation. */
  volatile: 30_000,
} as const;

export const queryClient = createQueryClient();

export default queryClient;
