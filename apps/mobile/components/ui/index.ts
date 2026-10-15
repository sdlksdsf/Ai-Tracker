/**
 * Design-system barrel.
 *
 * Screens import from `@/components/ui` so a component can be swapped or renamed
 * in one place. Nothing here may import a feature component or a store other than
 * `ui.store` (which Button and Toast need for haptics) — that keeps the design
 * system reusable and testable on its own.
 */

export { Text, ScreenTitle, SectionLabel, type TextProps, type TextVariant, type TextTone } from './Text.js';
export { Card, type CardProps } from './Card.js';
export { Button, IconButton, LinkButton, ButtonRow, type ButtonProps, type ButtonVariant, type ButtonSize, type IconButtonProps } from './Button.js';
export { Input, SelectField, QuantityStepper, type InputProps } from './Input.js';
export { Chip, ChipRow, type ChipProps } from './Chip.js';
export { Badge, CountBadge, type BadgeProps, type BadgeTone } from './Badge.js';
export { ProgressBar, LabeledProgress, MacroBar, type ProgressBarProps } from './Progress.js';
export { Skeleton, SkeletonList, RecipeCardSkeleton, ListRowSkeleton, type SkeletonProps } from './Skeleton.js';
export { EmptyState, ErrorState, type EmptyStateProps } from './EmptyState.js';
export { Sheet, OptionSheet, type SheetProps, type SheetOption } from './Sheet.js';
export { Screen, ScreenHeader, Centered, Divider, SectionHeader, type ScreenProps, type ScreenHeaderProps } from './Screen.js';
export { ToastHost } from './Toast.js';
export { FAB, SpeedDial, type FABProps, type SpeedDialAction } from './FAB.js';
