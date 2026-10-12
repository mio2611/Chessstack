// Manual check of the local-day helpers (no test framework in this project).
//
//   npx tsx scripts/check-local-days.ts
//
// Exits non-zero on the first failed assertion.

import assert from 'node:assert/strict';
import { computeStreak, periodStartDay, previousDay, resolveTimeZone } from '../src/lib/local-days';

const at = (iso: string) => new Date(iso);
let checks = 0;
function check(name: string, actual: unknown, expected: unknown) {
	assert.deepEqual(actual, expected, name);
	checks++;
	console.log(`ok  ${name}`);
}

// Paris is UTC+2 until 2026-10-25 03:00 (CEST), UTC+1 afterwards (CET).
const paris = 'Europe/Paris';

// 1. Just after local midnight: 22:45Z on the 12th is 00:45 on the 13th in Paris.
//    Events at 00:30 Paris (13th), 12th and 11th: 3 local days, but only 2 UTC days.
const midnightEvents = [
	at('2026-10-12T22:30:00Z'),
	at('2026-10-12T10:00:00Z'),
	at('2026-10-11T10:00:00Z')
];
const justAfterMidnight = at('2026-10-12T22:45:00Z');
check(
	'streak counts local days after midnight (Paris)',
	computeStreak(midnightEvents, justAfterMidnight, paris),
	3
);
check(
	'same events in UTC give a shorter streak',
	computeStreak(midnightEvents, justAfterMidnight, 'UTC'),
	2
);

// 2. Today empty, yesterday active: the streak is not broken yet.
check(
	'streak survives an empty today',
	computeStreak([at('2026-10-11T10:00:00Z')], at('2026-10-12T08:00:00Z'), paris),
	1
);

// 3. A full missed day breaks the streak.
check(
	'streak breaks after a missed day',
	computeStreak([at('2026-10-10T10:00:00Z')], at('2026-10-12T08:00:00Z'), paris),
	0
);

// 4. Daylight-saving change (25-hour day on 2026-10-25): no day lost or doubled.
const dstEvents = [
	at('2026-10-24T12:00:00Z'),
	at('2026-10-25T12:00:00Z'),
	at('2026-10-26T12:00:00Z')
];
check(
	'streak across the October DST change',
	computeStreak(dstEvents, at('2026-10-26T20:00:00Z'), paris),
	3
);

// 5. Daylight-saving change (23-hour day on 2026-03-29).
const springEvents = [
	at('2026-03-28T12:00:00Z'),
	at('2026-03-29T12:00:00Z'),
	at('2026-03-30T12:00:00Z')
];
check(
	'streak across the March DST change',
	computeStreak(springEvents, at('2026-03-30T20:00:00Z'), paris),
	3
);

// 6. Month and year boundaries.
check('previousDay across a month', previousDay('2026-03-01'), '2026-02-28');
check('previousDay across a year', previousDay('2026-01-01'), '2025-12-31');

// 7. Time zone fallback.
check('missing tz falls back to UTC', resolveTimeZone(undefined), 'UTC');
check('invalid tz falls back to UTC', resolveTimeZone('Not/AZone'), 'UTC');
check('valid tz is kept', resolveTimeZone(paris), paris);

// 8. Goal periods (2026-10-12 is a Monday, 2026-10-11 a Sunday).
check('daily period', periodStartDay('2026-10-14', 'daily'), '2026-10-14');
check('weekly period starts Monday', periodStartDay('2026-10-14', 'weekly'), '2026-10-12');
check('weekly period on a Monday', periodStartDay('2026-10-12', 'weekly'), '2026-10-12');
check('weekly period on a Sunday', periodStartDay('2026-10-11', 'weekly'), '2026-10-05');
check('weekly period across a month', periodStartDay('2026-11-01', 'weekly'), '2026-10-26');
check('monthly period', periodStartDay('2026-10-14', 'monthly'), '2026-10-01');

console.log(`\n${checks} checks passed`);
