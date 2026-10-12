// Dashboard page server load.
//
// Fetches all stats needed by the dashboard widgets:
//   - Gap Finder (existing)
//   - To do: due counts for Drill, Endgames and Blunders (same source as the
//     top-menu badges, see $lib/server/due-counts)
//   - Streak (consecutive local days with any study activity, all modules)
//   - Next Review (soonest due drill card after now)
//   - Card State Breakdown (New/Learning/Review/Relearning)
//   - Accuracy Trend (last 14 completed drill sessions of the active repertoire)
//   - Trouble Spots (cards with lapses >= 3)

import type { PageServerLoad } from './$types';
import { db } from '$lib/db';
import {
	userMove,
	userRepertoireMove,
	drillSession,
	puzzleAttempt,
	endgameReviewLog,
	antiGaffeReviewLog
} from '$lib/db/schema';
import { eq, and, gt, gte, desc, count } from 'drizzle-orm';
import { loadGapData } from '$lib/gaps';
import type { Gap } from '$lib/gaps';
import { gapRatingWindow } from '$lib/ratings';
import { scopeCards, isDue, countDueEndgame, countDueAntiGaffe } from '$lib/server/due-counts';
import type { DueCounts } from '$lib/server/due-counts';

/** Shape of a trouble-spot card returned to the page. */
export interface TroubleSpot {
	fromFen: string;
	san: string;
	lapses: number;
}

/** Shape of a recent drill session for the accuracy trend. */
export interface SessionSummary {
	cardsReviewed: number;
	cardsCorrect: number;
	completedAt: number; // unix timestamp (seconds)
}

/** Browser timezone from the `tz` cookie (set by +layout.svelte), UTC if absent or invalid. */
function resolveTimeZone(raw: string | undefined): string {
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
function makeDayFormatter(timeZone: string): (date: Date) => string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return (date) => fmt.format(date);
}

/** The calendar day before a YYYY-MM-DD string (pure string/UTC arithmetic). */
function previousDay(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

export const load: PageServerLoad = async ({ parent, locals, cookies }) => {
	const { repertoires, activeRepertoireId, settings } = await parent();

	// Defaults when there's nothing to show.
	const emptyStats = {
		repertoires,
		gaps: [] as Gap[],
		gapRatingLabel: gapRatingWindow(settings?.trainerRating ?? null).label,
		todo: { drill: 0, endgame: 0, antiGaffe: 0 } as DueCounts,
		totalCards: 0,
		nextReviewAt: null as number | null,
		cardStates: { new_: 0, learning: 0, review: 0, relearning: 0 },
		streak: 0,
		recentSessions: [] as SessionSummary[],
		troubleSpots: [] as TroubleSpot[],
		puzzleGoal: null as { count: number; frequency: string; solved: number } | null
	};

	if (!activeRepertoireId || repertoires.length === 0 || !locals.user) {
		return emptyStats;
	}

	const activeRep = repertoires.find((r) => r.id === activeRepertoireId);
	if (!activeRep) {
		return emptyStats;
	}

	const userId = locals.user.id;

	// ── User moves (needed for gap finder + scope filtering) ────────────
	const moves = await db
		.select()
		.from(userMove)
		.where(and(eq(userMove.repertoireId, activeRepertoireId), eq(userMove.userId, userId)));

	// ── Gap Finder (players DB, rating window centered on trainerRating) ────
	const gapRatingLabel = gapRatingWindow(settings?.trainerRating ?? null).label;
	const gaps = await loadGapData(
		db,
		moves,
		activeRep.color as 'WHITE' | 'BLACK',
		activeRep.startFen ?? null,
		settings?.gapMinGames ?? 10000,
		settings?.gapMinPopularityPct ?? 5,
		settings?.trainerRating ?? null
	);

	// ── SR cards for active repertoire ──────────────────────────────────
	const allCards = await db
		.select()
		.from(userRepertoireMove)
		.where(
			and(
				eq(userRepertoireMove.userId, userId),
				eq(userRepertoireMove.repertoireId, activeRepertoireId)
			)
		);

	// Scope-filter: only cards whose fromFen is reachable from start position.
	const scopedCards = scopeCards(activeRep, moves, allCards);

	const now = new Date();
	const totalCards = scopedCards.length;

	// ── To do (due counts per module) ───────────────────────────────────
	// The drill count comes from the cards already loaded above, the other two
	// from the same functions the top-menu badges use.
	const [endgameDue, antiGaffeDue] = await Promise.all([
		countDueEndgame(userId),
		countDueAntiGaffe(userId)
	]);
	const todo: DueCounts = {
		drill: scopedCards.filter((c) => isDue(c, now)).length,
		endgame: endgameDue,
		antiGaffe: antiGaffeDue
	};

	// ── Next Review (soonest due card after now) ────────────────────────
	let nextReviewAt: number | null = null;
	const futureCards = scopedCards
		.filter((c) => c.due && c.due > now)
		.sort((a, b) => a.due!.getTime() - b.due!.getTime());
	if (futureCards.length > 0) {
		nextReviewAt = Math.floor(futureCards[0].due!.getTime() / 1000);
	}

	// ── Card State Breakdown ────────────────────────────────────────────
	const cardStates = { new_: 0, learning: 0, review: 0, relearning: 0 };
	for (const c of scopedCards) {
		const s = c.state ?? 0;
		if (s === 0) cardStates.new_++;
		else if (s === 1) cardStates.learning++;
		else if (s === 2) cardStates.review++;
		else if (s === 3) cardStates.relearning++;
	}

	// ── Streak (consecutive local days with any study activity) ─────────
	// Activity = a completed drill session, an endgame or anti-gaffe review,
	// or a puzzle attempt. Days are calendar days in the browser's timezone
	// (cookie), not UTC. A streak doesn't break until a full day is missed:
	// if today has no activity yet but yesterday does, counting starts from
	// yesterday.
	const dayOf = makeDayFormatter(resolveTimeZone(cookies.get('tz')));
	const [drillDays, endgameDays, gaffeDays, puzzleDays] = await Promise.all([
		db
			.select({ at: drillSession.completedAt })
			.from(drillSession)
			.where(and(eq(drillSession.userId, userId), gt(drillSession.completedAt, new Date(0)))),
		db
			.select({ at: endgameReviewLog.reviewedAt })
			.from(endgameReviewLog)
			.where(eq(endgameReviewLog.userId, userId)),
		db
			.select({ at: antiGaffeReviewLog.reviewedAt })
			.from(antiGaffeReviewLog)
			.where(eq(antiGaffeReviewLog.userId, userId)),
		db
			.select({ at: puzzleAttempt.attemptedAt })
			.from(puzzleAttempt)
			.where(eq(puzzleAttempt.userId, userId))
	]);

	const activeDays = new Set<string>();
	for (const rows of [drillDays, endgameDays, gaffeDays, puzzleDays]) {
		for (const r of rows) {
			if (r.at) activeDays.add(dayOf(r.at));
		}
	}

	let streak = 0;
	let day = dayOf(now);
	if (!activeDays.has(day)) day = previousDay(day);
	while (activeDays.has(day)) {
		streak++;
		day = previousDay(day);
	}

	// ── Accuracy Trend (last 14 completed sessions of the active repertoire) ─
	const recentSessionRows = await db
		.select({
			cardsReviewed: drillSession.cardsReviewed,
			cardsCorrect: drillSession.cardsCorrect,
			completedAt: drillSession.completedAt
		})
		.from(drillSession)
		.where(
			and(
				eq(drillSession.userId, userId),
				eq(drillSession.repertoireId, activeRepertoireId),
				gt(drillSession.completedAt, new Date(0))
			)
		)
		.orderBy(desc(drillSession.completedAt))
		.limit(14);
	const recentSessions: SessionSummary[] = recentSessionRows
		.filter((s) => s.completedAt !== null && s.cardsReviewed > 0)
		.map((s) => ({
			cardsReviewed: s.cardsReviewed,
			cardsCorrect: s.cardsCorrect,
			completedAt: Math.floor(s.completedAt!.getTime() / 1000)
		}))
		.reverse(); // oldest first for left-to-right display

	// ── Trouble Spots (cards with lapses >= 3, top 5 by most lapses) ────
	const troubleSpots: TroubleSpot[] = scopedCards
		.filter((c) => (c.lapses ?? 0) >= 3)
		.sort((a, b) => (b.lapses ?? 0) - (a.lapses ?? 0))
		.slice(0, 5)
		.map((c) => ({
			fromFen: c.fromFen,
			san: c.san,
			lapses: c.lapses ?? 0
		}));

	// ── Puzzle Goal (solved count within current period) ────────────────
	let puzzleGoal: { count: number; frequency: string; solved: number } | null = null;

	if (settings?.puzzleGoalCount && settings?.puzzleGoalFrequency) {
		const periodStart = new Date(now);
		periodStart.setUTCHours(0, 0, 0, 0);

		if (settings.puzzleGoalFrequency === 'weekly') {
			// Week starts Monday: getUTCDay() 0=Sun,1=Mon,...,6=Sat
			const dow = periodStart.getUTCDay();
			periodStart.setUTCDate(periodStart.getUTCDate() - (dow === 0 ? 6 : dow - 1));
		} else if (settings.puzzleGoalFrequency === 'monthly') {
			periodStart.setUTCDate(1);
		}

		const [result] = await db
			.select({ solved: count() })
			.from(puzzleAttempt)
			.where(
				and(
					eq(puzzleAttempt.userId, userId),
					eq(puzzleAttempt.solved, true),
					gte(puzzleAttempt.attemptedAt, periodStart)
				)
			);

		puzzleGoal = {
			count: settings.puzzleGoalCount,
			frequency: settings.puzzleGoalFrequency,
			solved: Number(result.solved)
		};
	}

	return {
		repertoires,
		gaps,
		gapRatingLabel,
		todo,
		totalCards,
		nextReviewAt,
		cardStates,
		streak,
		recentSessions,
		troubleSpots,
		puzzleGoal
	};
};
