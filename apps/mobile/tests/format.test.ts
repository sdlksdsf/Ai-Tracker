import {
  formatCo2,
  formatDate,
  formatDuration,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatQuantityLabel,
  formatRelativeDays,
  formatShortDate,
  formatTimeAgo,
  formatWeight,
  humanize,
  pluralize,
  truncate,
  trimNumber,
} from '../lib/format.js';

/**
 * Display formatting.
 *
 * Every number the user reads passes through here, so a wrong unit symbol or a
 * "NaN kg" on the Home screen is a visible defect rather than a cosmetic one.
 */

describe('trimNumber', () => {
  it('drops a trailing .0 but keeps real precision', () => {
    expect(trimNumber(2)).toBe('2');
    expect(trimNumber(2.5)).toBe('2.5');
    expect(trimNumber(2.567)).toBe('2.57');
  });

  it('never emits NaN or Infinity', () => {
    expect(trimNumber(Number.NaN)).toBe('0');
    expect(trimNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatQuantityLabel', () => {
  it('joins a quantity and its unit', () => {
    expect(formatQuantityLabel(500, 'g')).toBe('500 g');
    expect(formatQuantityLabel(1.5, 'kg')).toBe('1.5 kg');
  });

  it('omits the label for countable units', () => {
    // "3 pieces" reads worse than "3" on a pantry row.
    expect(formatQuantityLabel(3, 'pieces')).toBe('3');
    expect(formatQuantityLabel(3, 'pcs')).toBe('3');
  });

  it('renders a bare number when there is no unit', () => {
    expect(formatQuantityLabel(2, null)).toBe('2');
  });

  it('renders an em dash rather than a blank for a missing quantity', () => {
    // A gap in the row looks like a layout bug; a dash reads as "not recorded".
    expect(formatQuantityLabel(null, 'g')).toBe('—');
    expect(formatQuantityLabel(undefined, undefined)).toBe('—');
  });

  it('passes an unknown unit through', () => {
    expect(formatQuantityLabel(2, 'punnet')).toBe('2 punnet');
  });
});

describe('formatMoney', () => {
  it('formats USD by default', () => {
    expect(formatMoney(18.4)).toBe('$18.40');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('supports other currencies', () => {
    expect(formatMoney(10, 'EUR')).toBe('€10.00');
    expect(formatMoney(10, 'GBP')).toBe('£10.00');
    expect(formatMoney(10, 'PKR')).toBe('₨10.00');
  });

  it('keeps the sign outside the currency symbol', () => {
    expect(formatMoney(-4.5)).toBe('-$4.50');
  });

  it('treats null and NaN as zero rather than printing "NaN"', () => {
    expect(formatMoney(null)).toBe('$0.00');
    expect(formatMoney(undefined)).toBe('$0.00');
    expect(formatMoney(Number.NaN)).toBe('$0.00');
  });

  it('honours a custom decimal count', () => {
    expect(formatMoney(1234.5678, 'USD', 0)).toBe('$1235');
  });
});

describe('formatMoneyCompact', () => {
  it('rolls large figures into thousands', () => {
    expect(formatMoneyCompact(1204)).toContain('k');
  });

  it('leaves small figures exact', () => {
    expect(formatMoneyCompact(18.4)).toBe('$18.40');
  });
});

describe('formatWeight', () => {
  it('uses grams below a kilogram and kilograms above', () => {
    expect(formatWeight(450)).toBe('450 g');
    expect(formatWeight(1500)).toBe('1.5 kg');
    expect(formatWeight(0)).toBe('0 g');
  });

  it('handles null', () => {
    expect(formatWeight(null)).toBe('0 g');
  });
});

describe('formatCo2', () => {
  it('labels the unit so the number means something', () => {
    expect(formatCo2(12.4)).toContain('CO₂e');
    expect(formatCo2(12.4)).toContain('12.4');
  });

  it('rolls up to tonnes', () => {
    expect(formatCo2(1500)).toContain('t CO₂e');
  });

  it('handles null', () => {
    expect(formatCo2(null)).toBe('0 kg CO₂e');
  });
});

describe('formatPercent', () => {
  it('rounds to a whole number', () => {
    expect(formatPercent(12.6)).toBe('13%');
  });

  it('adds a sign only when asked', () => {
    expect(formatPercent(12)).toBe('12%');
    expect(formatPercent(12, true)).toBe('+12%');
    expect(formatPercent(-12, true)).toBe('-12%');
  });

  it('does not sign a zero change', () => {
    expect(formatPercent(0, true)).toBe('0%');
  });
});

describe('formatRelativeDays', () => {
  it('names the near days instead of counting them', () => {
    expect(formatRelativeDays(0)).toBe('Today');
    expect(formatRelativeDays(1)).toBe('Tomorrow');
    expect(formatRelativeDays(-1)).toBe('Yesterday');
  });

  it('counts further out', () => {
    expect(formatRelativeDays(3)).toBe('In 3 days');
    expect(formatRelativeDays(-4)).toBe('4 days ago');
  });

  it('handles a missing date', () => {
    expect(formatRelativeDays(null)).toBe('No date');
  });
});

describe('formatDate / formatShortDate', () => {
  it('formats an ISO date deterministically', () => {
    expect(formatDate('2026-10-15')).toBe('15 Oct 2026');
    expect(formatShortDate('2026-10-15')).toBe('Thu 15 Oct');
  });

  it('does not shift the day for a bare date string', () => {
    // Parsing "2026-10-15" as UTC-midnight and formatting in local time would
    // show the 14th for anyone west of Greenwich.
    expect(formatDate('2026-10-15')).toContain('15');
  });

  it('handles timestamps and null', () => {
    expect(formatDate('2026-10-15T18:30:00Z')).toContain('2026');
    expect(formatDate(null)).toBe('—');
    expect(formatShortDate(null)).toBe('—');
  });

  it('passes through an unparseable string rather than printing Invalid Date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatTimeAgo', () => {
  const now = new Date('2026-10-15T12:00:00Z').getTime();

  it('uses friendly buckets', () => {
    expect(formatTimeAgo(new Date(now - 20_000).toISOString(), now)).toBe('just now');
    expect(formatTimeAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
    expect(formatTimeAgo(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3 hrs ago');
    expect(formatTimeAgo(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 days ago');
  });

  it('pluralises single units correctly', () => {
    expect(formatTimeAgo(new Date(now - 60_000).toISOString(), now)).toBe('1 min ago');
    expect(formatTimeAgo(new Date(now - 3600_000).toISOString(), now)).toBe('1 hr ago');
    expect(formatTimeAgo(new Date(now - 86_400_000).toISOString(), now)).toBe('1 day ago');
  });

  it('handles null and junk', () => {
    expect(formatTimeAgo(null)).toBe('—');
    expect(formatTimeAgo('garbage')).toBe('garbage');
  });
});

describe('formatDuration', () => {
  it('stays in minutes under an hour', () => {
    expect(formatDuration(25)).toBe('25 min');
  });

  it('rolls over to hours', () => {
    expect(formatDuration(75)).toBe('1 hr 15 min');
    expect(formatDuration(120)).toBe('2 hr');
  });

  it('handles missing and zero values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
  });
});

describe('humanize', () => {
  it('splits snake_case and title-cases', () => {
    expect(humanize('nut_seed')).toBe('Nut Seed');
    expect(humanize('didnt_like')).toBe('Didnt Like');
    expect(humanize('oil_fat')).toBe('Oil Fat');
  });

  it('handles kebab-case and plain words', () => {
    expect(humanize('low-fodmap')).toBe('Low Fodmap');
    expect(humanize('vegan')).toBe('Vegan');
  });

  it('handles empty input', () => {
    expect(humanize(null)).toBe('');
    expect(humanize('')).toBe('');
  });
});

describe('pluralize', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralize(1, 'day')).toBe('1 day');
    expect(pluralize(1, 'entry', 'entries')).toBe('1 entry');
  });

  it('uses the plural otherwise, including zero', () => {
    expect(pluralize(0, 'day')).toBe('0 days');
    expect(pluralize(3, 'entry', 'entries')).toBe('3 entries');
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('Soup', 20)).toBe('Soup');
  });

  it('adds an ellipsis and breaks on a word boundary', () => {
    const result = truncate('One-Pan Lemon Herb Chicken with Roasted Vegetables', 24);
    expect(result.length).toBeLessThanOrEqual(25);
    expect(result.endsWith('…')).toBe(true);
  });
});
