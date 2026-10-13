/**
 * Timezone-aware date calculations for token usage analytics.
 *
 * Ensures all day grouping, range slicing, and history bounds respect
 * the user's configured/system IANA timezone rather than UTC midnight.
 */

export function getLocalToday(
  timezone: string,
  now: Date = new Date(),
): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(now);
  } catch {
    // Fallback to UTC if timezone string is invalid
    return now.toISOString().slice(0, 10);
  }
}

export function shiftDateString(dateStr: string, daysDelta: number): string {
  const parts = dateStr.split('-').map((p) => parseInt(p, 10));
  const year = parts[0] ?? 2026;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;

  // Use UTC math so day shifts are pure 24h intervals independent of local daylight saving
  const ms = Date.UTC(year, month - 1, day) + daysDelta * 86_400_000;
  const res = new Date(ms);
  const y = res.getUTCFullYear();
  const m = String(res.getUTCMonth() + 1).padStart(2, '0');
  const d = String(res.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function generateDateSequence(since: string, until: string): string[] {
  if (since > until) return [];
  const dates: string[] = [];
  let cur = since;
  while (cur <= until) {
    dates.push(cur);
    cur = shiftDateString(cur, 1);
  }
  return dates;
}

export function calculateHistoryWindow(
  timezone: string,
  now: Date = new Date(),
  totalDays = 180,
): { since: string; until: string; days: number } {
  const until = getLocalToday(timezone, now);
  const since = shiftDateString(until, -(totalDays - 1));
  return { since, until, days: totalDays };
}

export function calculateRangeWindow(
  days: number,
  timezone: string,
  now: Date = new Date(),
): { since: string; until: string; days: number } {
  const count = Math.max(1, days);
  const until = getLocalToday(timezone, now);
  const since = shiftDateString(until, -(count - 1));
  return { since, until, days: count };
}
