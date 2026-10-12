// Calendar-day helpers in a given IANA time zone.
//
// Pure functions (no database, no framework imports) so the day arithmetic can
// be checked in isolation: see scripts/check-local-days.ts.
//
// Days are always compared as YYYY-MM-DD strings, never as millisecond
// differences, so a 23 h or 25 h day (daylight-saving change) cannot add or
// drop a day.

/** Browser timezone from the `tz` cookie, UTC if absent or invalid. */
export function resolveTimeZone(raw: string | undefined): string {
	if (raw) {
		try {
			new Intl.DateTimeFormat('en-CA', { timeZone: raw });
			return raw;
		} catch {
			// Unknown timezone name: fall through to UTC.
		}
	}
	return 'UTC';
}

/** YYYY-MM-DD string for `date` as seen in `timeZone` (en-CA formats this way). */
export function makeDayFormatter(timeZone: string): (date: Date) => string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return (date) => fmt.format(date);
}

/** The calendar day before a YYYY-MM-DD string (pure string/UTC arithmetic). */
export function previousDay(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

/**
 * Consecutive local days with at least one event, ending today. A streak does
 * not break until a full day is missed: if today has no event yet but
 * yesterday does, counting starts from yesterday.
 */
export function computeStreak(events: Date[], now: Date, timeZone: string): number {
	const dayOf = makeDayFormatter(timeZone);
	const activeDays = new Set<string>();
	for (const e of events) activeDays.add(dayOf(e));

	let streak = 0;
	let day = dayOf(now);
	if (!activeDays.has(day)) day = previousDay(day);
	while (activeDays.has(day)) {
		streak++;
		day = previousDay(day);
	}
	return streak;
}

/**
 * First local day (YYYY-MM-DD) of the goal period containing `today`.
 * 'weekly' starts on Monday, 'monthly' on the 1st, anything else is the day itself.
 */
export function periodStartDay(today: string, frequency: string): string {
	if (frequency === 'weekly') {
		const d = new Date(`${today}T00:00:00Z`);
		const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
		d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
		return d.toISOString().slice(0, 10);
	}
	if (frequency === 'monthly') return `${today.slice(0, 8)}01`;
	return today;
}
