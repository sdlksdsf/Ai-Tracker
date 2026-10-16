import { describe, expect, it } from 'vitest';
import { isQuietHour } from '../../src/services/notification.service.js';
import type { NotificationPreference } from '../../src/db/schema.js';

/**
 * Quiet hours.
 *
 * The comparison used to be hour-granularity, so a window of 22:30–07:30
 * silenced a 22:15 reminder (the whole of 22:00 counted as quiet) and a 07:00
 * window stayed quiet until 08:00. Minutes are part of the setting — the
 * settings screen is a time picker — so they are part of the check.
 */

/** Minimal stand-in: `isQuietHour` only reads the two window fields. */
function prefs(start: string | null, end: string | null): NotificationPreference {
  return { quietHoursStart: start, quietHoursEnd: end } as NotificationPreference;
}

const at = (iso: string) => new Date(iso);

describe('isQuietHour', () => {
  it('is off when either bound is unset', () => {
    expect(isQuietHour(prefs(null, '07:00'), 'UTC', at('2026-06-01T23:00:00Z'))).toBe(false);
    expect(isQuietHour(prefs('22:00', null), 'UTC', at('2026-06-01T23:00:00Z'))).toBe(false);
  });

  it('honours the minutes, not just the hour', () => {
    // A 22:30 window must not silence the 22:15 reminder…
    expect(isQuietHour(prefs('22:30', '07:00'), 'UTC', at('2026-06-01T22:15:00Z'))).toBe(false);
    // …and a 07:30 window ends at 07:30, not at 08:00.
    expect(isQuietHour(prefs('22:30', '07:30'), 'UTC', at('2026-06-01T07:15:00Z'))).toBe(true);
    expect(isQuietHour(prefs('22:30', '07:30'), 'UTC', at('2026-06-01T07:45:00Z'))).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    const window = prefs('22:00', '07:00');
    expect(isQuietHour(window, 'UTC', at('2026-06-01T23:59:00Z'))).toBe(true);
    expect(isQuietHour(window, 'UTC', at('2026-06-02T03:00:00Z'))).toBe(true);
    expect(isQuietHour(window, 'UTC', at('2026-06-02T12:00:00Z'))).toBe(false);
  });

  it('handles a window inside one day', () => {
    const window = prefs('13:00', '15:30');
    expect(isQuietHour(window, 'UTC', at('2026-06-01T13:00:00Z'))).toBe(true);
    expect(isQuietHour(window, 'UTC', at('2026-06-01T15:29:00Z'))).toBe(true);
    expect(isQuietHour(window, 'UTC', at('2026-06-01T15:30:00Z'))).toBe(false);
    expect(isQuietHour(window, 'UTC', at('2026-06-01T12:59:00Z'))).toBe(false);
  });

  it('treats a zero-length window as "no quiet hours", not "always quiet"', () => {
    expect(isQuietHour(prefs('22:00', '22:00'), 'UTC', at('2026-06-01T22:00:00Z'))).toBe(false);
    expect(isQuietHour(prefs('22:00', '22:00'), 'UTC', at('2026-06-01T12:00:00Z'))).toBe(false);
  });

  it('resolves the window in the user timezone', () => {
    // 23:00 in Karachi (UTC+5) is 18:00 UTC.
    expect(isQuietHour(prefs('22:00', '07:00'), 'Asia/Karachi', at('2026-06-01T18:00:00Z'))).toBe(true);
    // 06:30 in Karachi is 01:30 UTC — still inside the window that ends at 07:00.
    expect(isQuietHour(prefs('22:00', '07:00'), 'Asia/Karachi', at('2026-06-02T01:30:00Z'))).toBe(true);
    // 12:00 in Karachi is 07:00 UTC — outside it.
    expect(isQuietHour(prefs('22:00', '07:00'), 'Asia/Karachi', at('2026-06-01T07:00:00Z'))).toBe(false);
  });
});
