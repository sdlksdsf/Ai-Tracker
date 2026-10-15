/**
 * Design tokens (Spec Section 6 — Design System).
 *
 * Every colour, radius, spacing step and font size in the app comes from here.
 * Components must not hard-code a hex value or a bare number: that is what keeps
 * the 15 screens visually consistent and makes a future dark theme a one-file
 * change rather than a 200-file refactor.
 */

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const colors = {
  /** Primary brand green — CTAs, active tab, progress. */
  primary: '#2D8F4E',
  primaryDark: '#23713D',
  primaryLight: '#4CAF6E',
  primarySoft: '#E8F5EC',

  /** Secondary orange — "cook now" nudges, expiring-soon accents. */
  secondary: '#FF8C42',
  secondaryDark: '#E5722B',
  secondarySoft: '#FFF1E6',

  /** Accent blue — links, informational chips, charts. */
  accent: '#4A90D9',
  accentSoft: '#EAF3FC',

  success: '#27AE60',
  successSoft: '#E8F8EF',
  warning: '#F39C12',
  warningSoft: '#FEF5E7',
  danger: '#E74C3C',
  dangerSoft: '#FDEDEC',

  background: '#F7F8FA',
  surface: '#FFFFFF',
  surfaceAlt: '#FAFBFC',

  text: '#1A1A2E',
  textSecondary: '#6B7280',
  textTertiary: '#9CA3AF',
  textInverse: '#FFFFFF',

  border: '#E5E7EB',
  borderStrong: '#D1D5DB',
  divider: '#F0F1F3',

  /** Overlay behind sheets and modals. */
  overlay: 'rgba(26, 26, 46, 0.45)',

  /** Skeleton shimmer. */
  skeleton: '#EDEFF2',
  skeletonHighlight: '#F7F8FA',

  /** Category accents used by pantry and grocery grouping. */
  category: {
    vegetable: '#4CAF50',
    fruit: '#FF8C42',
    dairy: '#4A90D9',
    meat: '#E74C3C',
    seafood: '#00ACC1',
    grain: '#C8A165',
    spice: '#A0522D',
    condiment: '#F39C12',
    beverage: '#7E57C2',
    snack: '#EC407A',
    frozen: '#29B6F6',
    canned: '#8D6E63',
    bakery: '#D4A373',
    legume: '#7CB342',
    nut_seed: '#A1887F',
    oil_fat: '#FFD54F',
    sweetener: '#FF7043',
    other: '#9E9E9E',
  } as Record<string, string>,
} as const;

export type ColorToken = keyof typeof colors;

/**
 * Expiry urgency → colour. Mirrors `expiryUrgency()` in the API so the client
 * and server agree on what "critical" means.
 */
export const urgencyColors = {
  expired: colors.danger,
  critical: colors.danger,
  warning: colors.warning,
  soon: colors.secondary,
  ok: colors.success,
  none: colors.textTertiary,
} as const;

export const urgencyBackgrounds = {
  expired: colors.dangerSoft,
  critical: colors.dangerSoft,
  warning: colors.warningSoft,
  soon: colors.secondarySoft,
  ok: colors.successSoft,
  none: colors.divider,
} as const;

export type Urgency = keyof typeof urgencyColors;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * Inter for UI text, DM Sans for display headings (Section 6).
 *
 * Custom fonts are loaded by `useFonts` in the root layout; the families below
 * are the *loaded* names, and every entry has a system fallback so text renders
 * correctly on the very first frame before the fonts resolve.
 */
export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  display: 'DMSans_500Medium',
  displayBold: 'DMSans_700Bold',
} as const;

/** Fallbacks used until the custom fonts finish loading. */
export const fontFallback = {
  regular: 'System',
  medium: 'System',
  semibold: 'System',
  bold: 'System',
  display: 'System',
  displayBold: 'System',
} as const;

/**
 * Type scale.
 *
 * `lineHeight` is always paired with `fontSize` — unpaired text is the most
 * common cause of clipped descenders on Android.
 */
export const typography = {
  displayLarge: { fontSize: 34, lineHeight: 42, fontFamily: fonts.displayBold, letterSpacing: -0.8 },
  displayMedium: { fontSize: 28, lineHeight: 36, fontFamily: fonts.displayBold, letterSpacing: -0.6 },
  displaySmall: { fontSize: 24, lineHeight: 32, fontFamily: fonts.display, letterSpacing: -0.4 },

  headingLarge: { fontSize: 22, lineHeight: 30, fontFamily: fonts.bold, letterSpacing: -0.3 },
  headingMedium: { fontSize: 19, lineHeight: 26, fontFamily: fonts.bold, letterSpacing: -0.2 },
  headingSmall: { fontSize: 17, lineHeight: 24, fontFamily: fonts.semibold },

  bodyLarge: { fontSize: 16, lineHeight: 24, fontFamily: fonts.regular },
  body: { fontSize: 15, lineHeight: 22, fontFamily: fonts.regular },
  bodyMedium: { fontSize: 15, lineHeight: 22, fontFamily: fonts.medium },
  bodySmall: { fontSize: 13, lineHeight: 19, fontFamily: fonts.regular },

  caption: { fontSize: 12, lineHeight: 17, fontFamily: fonts.medium },
  captionSmall: { fontSize: 11, lineHeight: 15, fontFamily: fonts.regular },

  /** Tabular numerals for nutrition and money figures. */
  stat: { fontSize: 26, lineHeight: 32, fontFamily: fonts.bold, letterSpacing: -0.5 },
  statSmall: { fontSize: 20, lineHeight: 26, fontFamily: fonts.bold, letterSpacing: -0.3 },

  button: { fontSize: 16, lineHeight: 22, fontFamily: fonts.semibold, letterSpacing: 0.1 },
  buttonSmall: { fontSize: 14, lineHeight: 19, fontFamily: fonts.semibold },

  overline: { fontSize: 11, lineHeight: 15, fontFamily: fonts.semibold, letterSpacing: 0.8 },
} as const;

export type TypographyToken = keyof typeof typography;

// ---------------------------------------------------------------------------
// Radius  (Section 6: 12 cards/inputs, 8 chips/small, 24 sheets)
// ---------------------------------------------------------------------------

export const radii = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export type RadiusToken = keyof typeof radii;

// ---------------------------------------------------------------------------
// Spacing — an 4pt scale, so every gap is a multiple of 4
// ---------------------------------------------------------------------------

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export type SpacingToken = keyof typeof spacing;

/** Standard horizontal screen gutter. */
export const screenPadding = spacing.lg;

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * Shadows are defined once because iOS and Android express elevation differently.
 * `level0` is intentionally flat — most surfaces in this app are cards on a
 * tinted background, which reads better without a shadow.
 */
export const elevation = {
  level0: {},
  level1: {
    shadowColor: '#1A1A2E',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  level2: {
    shadowColor: '#1A1A2E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  level3: {
    shadowColor: '#1A1A2E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  level4: {
    shadowColor: '#1A1A2E',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 20,
    elevation: 10,
  },
} as const;

export type ElevationToken = keyof typeof elevation;

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

export const sizes = {
  /** Tap targets: 44pt on iOS, 48dp on Android. 48 satisfies both. */
  touchTarget: 48,
  inputHeight: 52,
  buttonHeight: 52,
  buttonHeightSm: 40,
  buttonHeightLg: 58,

  tabBarHeight: 64,
  headerHeight: 56,

  iconXs: 14,
  iconSm: 18,
  iconMd: 22,
  iconLg: 28,
  iconXl: 36,

  avatarSm: 32,
  avatarMd: 44,
  avatarLg: 64,
  avatarXl: 96,

  thumbnailSm: 48,
  thumbnailMd: 72,
  thumbnailLg: 112,

  cardImageHeight: 160,
  heroImageHeight: 240,

  borderWidth: 1,
  borderWidthThick: 2,
  dividerHeight: 1,

  progressHeight: 8,
  progressHeightSm: 4,
  skeletonRadius: radii.sm,
} as const;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export const motion = {
  instant: 100,
  fast: 180,
  normal: 260,
  slow: 400,
  deliberate: 600,

  easing: {
    standard: [0.4, 0, 0.2, 1] as [number, number, number, number],
    decelerate: [0, 0, 0.2, 1] as [number, number, number, number],
    accelerate: [0.4, 0, 1, 1] as [number, number, number, number],
    spring: { damping: 18, stiffness: 180, mass: 0.9 },
    gentleSpring: { damping: 22, stiffness: 120, mass: 1 },
  },
} as const;

// ---------------------------------------------------------------------------
// Layout breakpoints (tablet support)
// ---------------------------------------------------------------------------

export const breakpoints = {
  phone: 0,
  tablet: 600,
  desktop: 1024,
} as const;

/** Max content width so a tablet does not stretch a card to 1000pt. */
export const maxContentWidth = 720;

// ---------------------------------------------------------------------------
// Z-index
// ---------------------------------------------------------------------------

export const zIndex = {
  content: 0,
  sticky: 10,
  header: 20,
  fab: 30,
  tabBar: 40,
  overlay: 50,
  sheet: 60,
  toast: 70,
} as const;

// ---------------------------------------------------------------------------
// Ingredient category presentation
// ---------------------------------------------------------------------------

/** Emoji per category — used on pantry and grocery rows (Section 6, Screen 9). */
export const categoryEmoji: Record<string, string> = {
  vegetable: '🥬',
  fruit: '🍎',
  dairy: '🥛',
  meat: '🍗',
  seafood: '🐟',
  grain: '🌾',
  spice: '🧂',
  condiment: '🥫',
  beverage: '🧃',
  snack: '🍿',
  frozen: '🧊',
  canned: '🥘',
  bakery: '🍞',
  legume: '🫘',
  nut_seed: '🥜',
  oil_fat: '🫒',
  sweetener: '🍯',
  other: '🍽️',
};

export const mealTypeEmoji: Record<string, string> = {
  breakfast: '🍳',
  lunch: '🥗',
  dinner: '🍲',
  snack: '🍎',
};

export const difficultyEmoji: Record<string, string> = {
  easy: '🟢',
  medium: '🟡',
  hard: '🔴',
};

/**
 * Fallbacks resolved once at module load.
 *
 * `colors.category` and `categoryEmoji` are `Record<string, string>`, so with
 * `noUncheckedIndexedAccess` every lookup — including the `.other` entry these
 * functions fall back to — is `string | undefined`. Reading the fallback into a
 * `string` here keeps the source of truth in the maps while letting the public
 * helpers honestly promise a `string`.
 */
const NEUTRAL_CATEGORY_COLOR: string = colors.category.other ?? '#9E9E9E';
const NEUTRAL_CATEGORY_EMOJI: string = categoryEmoji.other ?? '🍎';

/** Resolve a category colour, falling back to the neutral grey. */
export function categoryColor(category: string | null | undefined): string {
  if (!category) return NEUTRAL_CATEGORY_COLOR;
  return colors.category[category] ?? NEUTRAL_CATEGORY_COLOR;
}

export function categoryIcon(category: string | null | undefined): string {
  if (!category) return NEUTRAL_CATEGORY_EMOJI;
  return categoryEmoji[category] ?? NEUTRAL_CATEGORY_EMOJI;
}

// ---------------------------------------------------------------------------
// Theme object
// ---------------------------------------------------------------------------

export const theme = {
  colors,
  typography,
  fonts,
  radii,
  spacing,
  sizes,
  elevation,
  motion,
  zIndex,
  breakpoints,
} as const;

export type Theme = typeof theme;

export default theme;
