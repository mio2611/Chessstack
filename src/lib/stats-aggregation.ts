// Pure helpers behind the /stats retention and matured-cards charts.
//
// No database or framework imports so the arithmetic can be checked in
// isolation: see scripts/check-stats-aggregation.ts.
//
// The server turns raw review_log rows into one DailyStat per local calendar
// day (buildDailyStats). The client then picks a period and folds those days
// into chart buckets (buildChartData): days for "1 month", weeks otherwise.

import { Rating, State } from './fsrs';
import { periodStartDay, makeDayFormatter } from './local-days';

/** Anki's convention: a card is mature once its interval reaches 21 days. */
export const MATURE_THRESHOLD_DAYS = 21;

/** True when a card in `state` with a scheduled interval of `scheduledDays` is mature. */
export function isMature(state: number, scheduledDays: number | null | undefined): boolean {
	return state === State.Review && (scheduledDays ?? 0) >= MATURE_THRESHOLD_DAYS;
}

/** The review_log columns the aggregation needs. */
export interface ReviewLogRow {
	reviewedAt: Date;
	rating: number;
	source: string;
	stateBefore: number;
	scheduledDaysBefore: number | null;
	stateAfter: number;
	scheduledDaysAfter: number;
}

/** One local calendar day of review activity. */
export interface DailyStat {
	day: string; // YYYY-MM-DD in the viewer's time zone
	youngReviews: number;
	youngSuccess: number;
	matureReviews: number;
	matureSuccess: number;
	matured: number; // cards that became mature this day
	lost: number; // cards that stopped being mature this day
}

/** Reviews that count toward retention: scheduled drill reviews of cards in the Review state. */
export function countsForRetention(row: ReviewLogRow): boolean {
	return row.source === 'DRILL' && row.stateBefore === State.Review;
}

/** Folds log rows into one entry per local day (days without any event are omitted), oldest first. */
export function buildDailyStats(rows: ReviewLogRow[], timeZone: string): DailyStat[] {
	const dayOf = makeDayFormatter(timeZone);
	const byDay = new Map<string, DailyStat>();
	for (const row of rows) {
		const day = dayOf(row.reviewedAt);
		let stat = byDay.get(day);
		if (!stat) {
			stat = {
				day,
				youngReviews: 0,
				youngSuccess: 0,
				matureReviews: 0,
				matureSuccess: 0,
				matured: 0,
				lost: 0
			};
			byDay.set(day, stat);
		}

		if (countsForRetention(row)) {
			const success = row.rating !== Rating.Again;
			if (isMature(row.stateBefore, row.scheduledDaysBefore)) {
				stat.matureReviews++;
				if (success) stat.matureSuccess++;
			} else {
				stat.youngReviews++;
				if (success) stat.youngSuccess++;
			}
		}

		// Maturity transitions count every source: a game-review failure that
		// resets a mature card is a real loss even though it is not a scheduled review.
		const wasMature = isMature(row.stateBefore, row.scheduledDaysBefore);
		const nowMature = isMature(row.stateAfter, row.scheduledDaysAfter);
		if (!wasMature && nowMature) stat.matured++;
		else if (wasMature && !nowMature) stat.lost++;
	}
	return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// ─── Periods and buckets ─────────────────────────────────────────────────────

export type Period = '1m' | '1y' | 'all';
export type Granularity = 'day' | 'week';

export const PERIOD_DAYS: Record<Exclude<Period, 'all'>, number> = { '1m': 30, '1y': 365 };

/** The calendar day `n` days after (or before, if negative) a YYYY-MM-DD string. */
export function addDays(day: string, n: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD), inclusive of both ends. */
export function inclusiveDayCount(from: string, to: string): number {
	const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
	return Math.round(ms / 86_400_000) + 1;
}

export interface ChartBucket {
	start: string; // first day of the bucket (the day itself, or the Monday of the week)
	youngReviews: number;
	youngSuccess: number;
	matureReviews: number;
	matureSuccess: number;
	matured: number;
	lost: number;
}

export interface ChartData {
	granularity: Granularity;
	buckets: ChartBucket[];
	firstDay: string; // first day covered by the chart
	rangeDays: number; // days from firstDay to today, inclusive
}

function emptyBucket(start: string): ChartBucket {
	return {
		start,
		youngReviews: 0,
		youngSuccess: 0,
		matureReviews: 0,
		matureSuccess: 0,
		matured: 0,
		lost: 0
	};
}

/**
 * Buckets for a period ending on `today`. The axis never starts before the
 * first logged day (the log is not retroactive, so earlier days are unknown
 * rather than empty). Returns null when there is no log at all.
 */
export function buildChartData(
	daily: DailyStat[],
	period: Period,
	today: string
): ChartData | null {
	if (daily.length === 0) return null;

	const firstLogged = daily[0].day;
	let firstDay = firstLogged;
	if (period !== 'all') {
		const windowStart = addDays(today, -(PERIOD_DAYS[period] - 1));
		if (windowStart > firstDay) firstDay = windowStart;
	}
	if (firstDay > today) firstDay = today;

	const granularity: Granularity = period === '1m' ? 'day' : 'week';
	const keyOf = (day: string) => (granularity === 'day' ? day : periodStartDay(day, 'weekly'));

	// Every bucket between the first and last key exists, even when empty.
	const buckets = new Map<string, ChartBucket>();
	const step = granularity === 'day' ? 1 : 7;
	for (let key = keyOf(firstDay); key <= keyOf(today); key = addDays(key, step)) {
		buckets.set(key, emptyBucket(key));
	}

	for (const d of daily) {
		if (d.day < firstDay || d.day > today) continue;
		const b = buckets.get(keyOf(d.day));
		if (!b) continue;
		b.youngReviews += d.youngReviews;
		b.youngSuccess += d.youngSuccess;
		b.matureReviews += d.matureReviews;
		b.matureSuccess += d.matureSuccess;
		b.matured += d.matured;
		b.lost += d.lost;
	}

	return {
		granularity,
		buckets: Array.from(buckets.values()),
		firstDay,
		rangeDays: inclusiveDayCount(firstDay, today)
	};
}

/** Success rate in [0, 1], or null when there is nothing to divide. */
export function rate(success: number, total: number): number | null {
	return total > 0 ? success / total : null;
}

/** Net change in matured cards per bucket, plus the running total. */
export function netSeries(buckets: ChartBucket[]): { net: number[]; cumulative: number[] } {
	const net: number[] = [];
	const cumulative: number[] = [];
	let sum = 0;
	for (const b of buckets) {
		const n = b.matured - b.lost;
		sum += n;
		net.push(n);
		cumulative.push(sum);
	}
	return { net, cumulative };
}

// ─── Axis helpers ────────────────────────────────────────────────────────────

/** Smallest 1, 2, 5 x 10^k that is >= x (x > 0). */
export function niceCeil(x: number): number {
	if (x <= 0) return 1;
	const exp = Math.floor(Math.log10(x));
	const base = 10 ** exp;
	const m = x / base;
	const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
	return nice * base;
}

/**
 * Two value ranges (each with min <= 0 <= max) widened so that zero sits at the
 * same relative height in both. Lets a bar axis and a cumulative-line axis
 * share one zero line.
 */
export function alignZero(
	a: [number, number],
	b: [number, number]
): { a: [number, number]; b: [number, number] } {
	const negFraction = (r: [number, number]) => {
		const neg = -r[0];
		const pos = r[1];
		return neg + pos > 0 ? neg / (neg + pos) : 0;
	};
	const fz = Math.max(negFraction(a), negFraction(b));
	const widen = (r: [number, number]): [number, number] => {
		const neg = -r[0];
		const pos = r[1];
		if (fz <= 0) return [0, niceCeil(pos || 1)];
		if (fz >= 1) return [-niceCeil(neg || 1), 0];
		const total = niceCeil(Math.max(neg / fz, pos / (1 - fz)) || 1);
		return [-fz * total, (1 - fz) * total];
	};
	return { a: widen(a), b: widen(b) };
}

// ─── Struggling cards (the red dot on the Build graph) ───────────────────────

/** A card with at least this many lapses that is not mature gets the red dot. */
export const STRUGGLE_LAPSE_THRESHOLD = 3;

/**
 * True when the Build graph shows the red dot on a card. Single source of truth
 * for GraphView and the /stats snapshots, so the dots and the chart cannot drift.
 *
 * Careful: the graph's maturity test is strictly greater than 21 days, while
 * isMature above (the /stats convention) is 21 days or more. A card scheduled
 * for exactly 21 days therefore counts as mature in /stats but not in the
 * graph; the dot follows the graph here on purpose.
 */
export function isStrugglingCard(card: {
	state: number | null;
	lapses: number | null;
	scheduledDays: number | null;
}): boolean {
	const matureInGraph =
		(card.state ?? State.New) === State.Review && (card.scheduledDays ?? 0) > MATURE_THRESHOLD_DAYS;
	return (card.lapses ?? 0) >= STRUGGLE_LAPSE_THRESHOLD && !matureInGraph;
}

// ─── Card snapshots (total and struggling cards over time) ───────────────────

/** One stored snapshot: the counts of one local day. */
export interface CardSnapshotPoint {
	day: string; // YYYY-MM-DD in the viewer's time zone
	total: number;
	struggling: number;
}

export interface SnapshotBucket {
	start: string; // first day of the bucket (the day itself, or the Monday of the week)
	total: number; // value at the end of the bucket
	struggling: number;
}

export interface SnapshotSeries {
	granularity: Granularity;
	buckets: SnapshotBucket[];
	firstDay: string;
}

/**
 * Snapshot values per bucket for a period ending on `today`. A snapshot is a
 * level, not a flow: days without a snapshot (app not opened) carry the last
 * known value forward, and a week shows its last value. The axis never starts
 * before the first snapshot. Returns null when there is none.
 */
export function buildSnapshotSeries(
	points: CardSnapshotPoint[],
	period: Period,
	today: string
): SnapshotSeries | null {
	const sorted = points
		.filter((p) => p.day <= today)
		.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
	if (sorted.length === 0) return null;

	let firstDay = sorted[0].day;
	if (period !== 'all') {
		const windowStart = addDays(today, -(PERIOD_DAYS[period] - 1));
		if (windowStart > firstDay) firstDay = windowStart;
	}

	const granularity: Granularity = period === '1m' ? 'day' : 'week';
	const keyOf = (day: string) => (granularity === 'day' ? day : periodStartDay(day, 'weekly'));
	const step = granularity === 'day' ? 1 : 7;

	const buckets: SnapshotBucket[] = [];
	let i = 0;
	let last = sorted[0];
	for (let key = keyOf(firstDay); key <= keyOf(today); key = addDays(key, step)) {
		const end = addDays(key, step - 1);
		while (i < sorted.length && sorted[i].day <= end) {
			last = sorted[i];
			i++;
		}
		buckets.push({ start: key, total: last.total, struggling: last.struggling });
	}
	return { granularity, buckets, firstDay };
}
