// Manual check of the /stats aggregation helpers (no test framework in this project).
//
//   npx tsx scripts/check-stats-aggregation.ts
//
// Exits non-zero on the first failed assertion.

import assert from 'node:assert/strict';
import {
	alignZero,
	buildChartData,
	buildDailyStats,
	isMature,
	netSeries,
	rate,
	type ReviewLogRow
} from '../src/lib/stats-aggregation';

let checks = 0;
function check(name: string, actual: unknown, expected: unknown) {
	assert.deepEqual(actual, expected, name);
	checks++;
	console.log(`ok  ${name}`);
}

// ts-fsrs states: New 0, Learning 1, Review 2, Relearning 3. Ratings: Again 1, Good 3, Easy 4.
const row = (over: Partial<ReviewLogRow>): ReviewLogRow => ({
	reviewedAt: new Date('2026-10-10T10:00:00Z'),
	rating: 3,
	source: 'DRILL',
	stateBefore: 2,
	scheduledDaysBefore: 5,
	stateAfter: 2,
	scheduledDaysAfter: 10,
	...over
});

// 1. Maturity threshold is >= 21 days, Review state only.
check('20 days is young', isMature(2, 20), false);
check('21 days is mature', isMature(2, 21), true);
check('Relearning with a long interval is not mature', isMature(3, 40), false);
check('null interval is young', isMature(2, null), false);

// 2. Retention: Review-state DRILL reviews only, split at 21 days.
const retentionRows = [
	row({ scheduledDaysBefore: 20, rating: 3 }), // young success
	row({ scheduledDaysBefore: 20, rating: 1, stateAfter: 3, scheduledDaysAfter: 0 }), // young fail
	row({ scheduledDaysBefore: 21, rating: 4, scheduledDaysAfter: 40 }), // mature success
	row({ stateBefore: 0, scheduledDaysBefore: null, stateAfter: 1, scheduledDaysAfter: 0 }), // new card: ignored
	row({ stateBefore: 1, scheduledDaysBefore: 0 }), // learning step: ignored
	row({ stateBefore: 3, scheduledDaysBefore: 0 }), // relearning step: ignored
	row({ source: 'REVIEW_DEVIATION', scheduledDaysBefore: 5, rating: 1 }) // not a scheduled review: ignored
];
const [d1] = buildDailyStats(retentionRows, 'UTC');
check('young reviews', [d1.youngReviews, d1.youngSuccess], [2, 1]);
check('mature reviews', [d1.matureReviews, d1.matureSuccess], [1, 1]);

// 3. Net matured: counts every source, in both directions.
const maturedRows = [
	row({ scheduledDaysBefore: 15, scheduledDaysAfter: 30 }), // young -> mature
	row({ stateBefore: 3, scheduledDaysBefore: 0, scheduledDaysAfter: 25 }), // relearning -> mature
	row({ scheduledDaysBefore: 30, rating: 1, stateAfter: 3, scheduledDaysAfter: 0 }), // mature -> lost
	row({
		source: 'REVIEW_DEVIATION',
		scheduledDaysBefore: 60,
		rating: 1,
		stateAfter: 3,
		scheduledDaysAfter: 0
	}), // lost via game review
	row({ scheduledDaysBefore: 30, scheduledDaysAfter: 60 }), // stays mature: no change
	row({ scheduledDaysBefore: 5, scheduledDaysAfter: 10 }) // stays young: no change
];
const [d2] = buildDailyStats(maturedRows, 'UTC');
check('matured and lost', [d2.matured, d2.lost], [2, 2]);

// 4. Local day: 22:30Z on the 12th is 00:30 on the 13th in Paris (CEST).
const lateRow = row({ reviewedAt: new Date('2026-10-12T22:30:00Z') });
check('Paris day', buildDailyStats([lateRow], 'Europe/Paris')[0].day, '2026-10-13');
check('UTC day', buildDailyStats([lateRow], 'UTC')[0].day, '2026-10-12');

// 5. Daily chart: 30 days ending today, clipped to the first logged day.
const daily = buildDailyStats(
	[
		row({ reviewedAt: new Date('2026-10-05T10:00:00Z'), scheduledDaysBefore: 3 }),
		row({ reviewedAt: new Date('2026-10-12T10:00:00Z'), scheduledDaysBefore: 30 })
	],
	'UTC'
);
const month = buildChartData(daily, '1m', '2026-10-13')!;
check('1m is daily', month.granularity, 'day');
check(
	'1m clipped to first log day',
	[month.firstDay, month.buckets.length, month.rangeDays],
	['2026-10-05', 9, 9]
);
check('empty days are present', month.buckets[1].youngReviews, 0);

// 6. Weekly chart: buckets start on Monday (2026-10-05 is a Monday).
const year = buildChartData(daily, '1y', '2026-10-13')!;
check('1y is weekly', year.granularity, 'week');
check(
	'weekly keys are Mondays',
	year.buckets.map((b) => b.start),
	['2026-10-05', '2026-10-12']
);
check(
	'week 1 holds the young review, week 2 the mature one',
	year.buckets.map((b) => [b.youngReviews, b.matureReviews]),
	[
		[1, 0],
		[0, 1]
	]
);

// 7. A full 30 day window with older data: starts exactly 29 days before today.
const old = buildDailyStats([row({ reviewedAt: new Date('2025-01-01T10:00:00Z') })], 'UTC');
const fullMonth = buildChartData(old, '1m', '2026-10-13')!;
check('1m window length', [fullMonth.firstDay, fullMonth.buckets.length], ['2026-09-14', 30]);
check(
	'all starts at the first log day',
	buildChartData(old, 'all', '2026-10-13')!.firstDay,
	'2025-01-01'
);
check('no log gives null', buildChartData([], '1m', '2026-10-13'), null);

// 8. Rates and series.
check('rate of nothing is null', rate(0, 0), null);
check('rate', rate(3, 4), 0.75);
check(
	'net and cumulative',
	netSeries([
		{
			start: 'a',
			youngReviews: 0,
			youngSuccess: 0,
			matureReviews: 0,
			matureSuccess: 0,
			matured: 3,
			lost: 1
		},
		{
			start: 'b',
			youngReviews: 0,
			youngSuccess: 0,
			matureReviews: 0,
			matureSuccess: 0,
			matured: 0,
			lost: 2
		}
	]),
	{ net: [2, -2], cumulative: [2, 0] }
);

// 9. Zero alignment: both axes put zero at the same relative height.
const { a, b } = alignZero([-2, 6], [0, 46]);
const zeroFrac = (r: [number, number]) => -r[0] / (r[1] - r[0]);
assert.ok(Math.abs(zeroFrac(a) - zeroFrac(b)) < 1e-9, 'zero aligned');
assert.ok(a[0] <= -2 && a[1] >= 6 && b[0] <= 0 && b[1] >= 46, 'ranges still cover the data');
checks++;
console.log('ok  zero alignment');
check('no negatives keeps zero at the bottom', alignZero([0, 6], [0, 46]), {
	a: [0, 10],
	b: [0, 50]
});

console.log(`\n${checks} checks passed`);
