/**
 * Display formatting.
 *
 * The API returns canonical units and raw numbers; every user-facing string is
 * produced here so "500 g", "$18.40" and "3 days left" read the same on all 15
 * screens.
 */

/** Units we never pluralise or abbreviate further. */
const UNIT_LABELS: Record<string, string> = {
  g: 'g',
  kg: 'kg',
  mg: 'mg',
  ml: 'ml',
  l: 'L',
  oz: 'oz',
  lb: 'lb',
  pieces: '',
  piece: '',
  pcs: '',
  cups: 'cups',
  cup: 'cup',
  tbsp: 'tbsp',
  tsp: 'tsp',
  cloves: 'cloves',
  clove: 'clove',
  slices: 'slices',
  slice: 'slice',
  cans: 'cans',
  can: 'can',
  bunches: 'bunches',
  bunch: 'bunch',
  heads: 'heads',
  head: 'head',
  pinch: 'pinch',
  dash: 'dash',
  handful: 'handful',
};

/** Strip a trailing ".0" without rounding away real precision. */
export function trimNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toFixed(decimals));
  return String(rounded);
}

/**
 * Quantity + unit as a single label.
 *
 * `500, 'g'` → "500 g"; `3, 'pieces'` → "3"; `null, null` → "—" so a row never
 * renders an empty gap where a quantity should be.
 */
export function formatQuantityLabel(quantity: number | null | undefined, unit: string | null | undefined): string {
  if (quantity == null || !Number.isFinite(quantity)) return '—';

  const amount = trimNumber(quantity);
  if (!unit) return amount;

  const label = UNIT_LABELS[unit.toLowerCase()] ?? unit;
  return label ? `${amount} ${label}` : amount;
}

/** Money in the given currency, defaulting to USD. */
export function formatMoney(amount: number | null | undefined, currency = 'USD', decimals = 2): string {
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;

  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', PKR: '₨', CAD: 'CA$', AUD: 'A$' };
  const symbol = symbols[currency] ?? `${currency} `;

  const formatted = Math.abs(value).toFixed(decimals);
  return value < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

/** Compact money for tight spaces: $1.2k rather than $1,204.00. */
export function formatMoneyCompact(amount: number | null | undefined, currency = 'USD'): string {
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  if (Math.abs(value) >= 1000) return formatMoney(value / 1000, currency, 1).replace(/(\d)([.,]\d)?$/, '$1$2k');
  return formatMoney(value, currency, value >= 100 ? 0 : 2);
}

/** Weight in the most readable unit: 1.2 kg rather than 1200 g. */
export function formatWeight(grams: number | null | undefined): string {
  const value = Number.isFinite(Number(grams)) ? Number(grams) : 0;
  if (value === 0) return '0 g';
  if (Math.abs(value) >= 1000) return `${trimNumber(value / 1000, 2)} kg`;
  return `${trimNumber(value, 0)} g`;
}

/** CO₂ in kg, with a tonne rollover for lifetime totals. */
export function formatCo2(kg: number | null | undefined): string {
  const value = Number.isFinite(Number(kg)) ? Number(kg) : 0;
  if (Math.abs(value) >= 1000) return `${trimNumber(value / 1000, 2)} t CO₂e`;
  return `${trimNumber(value, 1)} kg CO₂e`;
}

/** Whole-number percent with a sign for deltas. */
export function formatPercent(value: number | null | undefined, signed = false): string {
  const num = Number.isFinite(Number(value)) ? Number(value) : 0;
  const rounded = Math.round(num);
  if (signed && rounded > 0) return `+${rounded}%`;
  return `${rounded}%`;
}

/** "Today", "Tomorrow", "in 3 days", "2 days ago" from a day offset. */
export function formatRelativeDays(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return 'No date';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1) return `In ${days} days`;
  return `${Math.abs(days)} days ago`;
}

/** ISO date → "15 Oct 2026", locale-independent so screenshots stay stable. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** ISO date → "Thu 15 Oct" for week views. */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

/** ISO timestamp → "14:32" or "2:32 PM" depending on the 12-hour preference. */
export function formatTime(iso: string | null | undefined, use24Hour = true): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');

  if (use24Hour) return `${String(hours).padStart(2, '0')}:${minutes}`;

  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

/** "3 days ago" / "2 hours ago" / "just now" from a timestamp. */
export function formatTimeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} wk${weeks === 1 ? '' : 's'} ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo${months === 1 ? '' : 's'} ago`;

  const years = Math.round(days / 365);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
}

/** Duration in minutes → "25 min" or "1 hr 15 min". */
export function formatDuration(minutes: number | null | undefined): string {
  const value = Number.isFinite(Number(minutes)) ? Number(minutes) : 0;
  if (value <= 0) return '—';
  if (value < 60) return `${Math.round(value)} min`;

  const hours = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** Title-case an enum value: `nut_seed` → "Nut Seed". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Pluralise a count: `1 item`, `3 items`. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural ?? `${singular}s`}`;
}

/** Truncate with an ellipsis, respecting word boundaries where possible. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, Math.max(0, max - 1));
  const lastSpace = sliced.lastIndexOf(' ');
  return `${lastSpace > max * 0.5 ? sliced.slice(0, lastSpace) : sliced}…`;
}
