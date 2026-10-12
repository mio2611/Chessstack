// Dashboard page server load.
//
// Fetches all stats needed by the dashboard widgets:
//   - Gap Finder (existing)
//   - To do: due counts for Drill, Endgames and Blunders (same source as the
//     top-menu badges, see $lib/server/due-counts)
//   - Streak (consecutive local days with any study activity, all modules)
//   - Puzzle goal (solved puzzles in the current local day/week/month)
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
	reviewLog,
	endgameReviewLog,
	antiGaffeReviewLog
} from '$lib/db/schema';
import { eq, and, gt, desc } from 'drizzle-orm';
import { loadGapData } from '$lib/gaps';
import type { Gap } from '$lib/gaps';
import { gapRatingWindow } from '$lib/ratings';
import { scopeCards, isDue, countDueEndgame, countDueAntiGaffe } from '$lib/server/due-counts';
import type { DueCounts } from '$lib/server/due-counts';
import { resolveTimeZone, makeDayFormatter, computeStreak, periodStartDay } from '$lib/local-days';

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

	if (!locals.user) {
		return emptyStats;
	}

	const userId = locals.user.id;
	const now = new Date();
	const timeZone = resolveTimeZone(cookies.get('tz'));
	const dayOf = makeDayFormatter(timeZone);

	// ── Data that does not depend on a repertoire ───────────────────────
	// Endgames, Blunders and the study streak are independent of the active
	// repertoire, so they are computed before any repertoire check: the To do
	// widget must agree with the top-menu badges even with no active repertoire.
	// Activity = any FSRS grade on a drill card (review_log, one row per grade,
	// so an abandoned drill session still counts), an endgame or anti-gaffe
	// review, or a puzzle attempt.
	const [endgameDue, antiGaffeDue, drillReviews, endgameReviews, gaffeReviews, puzzleRows] =
		await Promise.all([
			countDueEndgame(userId),
			countDueAntiGaffe(userId),
			db.select({ at: reviewLog.reviewedAt }).from(reviewLog).where(eq(reviewLog.userId, userId)),
			db
				.select({ at: endgameReviewLog.reviewedAt })
				.from(endgameReviewLog)
				.where(eq(endgameReviewLog.userId, userId)),
			db
				.select({ at: antiGaffeReviewLog.reviewedAt })
				.from(antiGaffeReviewLog)
				.where(eq(antiGaffeReviewLog.userId, userId)),
			db
				.select({ at: puzzleAttempt.attemptedAt, solved: puzzleAttempt.solved })
				.from(puzzleAttempt)
				.where(eq(puzzleAttempt.userId, userId))
		]);

	// ── Streak (consecutive local days with any study activity) ─────────
	// Days are calendar days in the browser's timezone (cookie), not UTC.
	const activityDates: Date[] = [];
	for (const rows of [drillReviews, endgameReviews, gaffeReviews, puzzleRows]) {
		for (const r of rows) {
			if (r.at) activityDates.push(r.at);
		}
	}
	const streak = computeStreak(activityDates, now, timeZone);

	// ── Puzzle Goal (solved count within current local period) ──────────
	// The period (day, Monday-based week, month) is bounded by local calendar
	// days, like the streak, and compared as YYYY-MM-DD strings.
	let puzzleGoal: { count: number; frequency: string; solved: number } | null = null;
	if (settings?.puzzleGoalCount && settings?.puzzleGoalFrequency) {
		const startDay = periodStartDay(dayOf(now), settings.puzzleGoalFrequency);
		puzzleGoal = {
			count: settings.puzzleGoalCount,
			frequency: settings.puzzleGoalFrequency,
			solved: puzzleRows.filter((r) => r.solved && r.at && dayOf(r.at) >= startDay).length
		};
	}

	const activeRep = repertoires.find((r) => r.id === activeRepertoireId);
	if (!activeRep) {
		return {
			...emptyStats,
			todo: { drill: 0, endgame: endgameDue, antiGaffe: antiGaffeDue } as DueCounts,
			streak,
			puzzleGoal
		};
	}

	// ── User moves (needed for gap finder + scope filtering) ────────────
	const moves = await db
		.select()
		.from(userMove)
		.where(and(eq(userMove.repertoireId, activeRep.id), eq(userMove.userId, userId)));

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
			and(eq(userRepertoireMove.userId, userId), eq(userRepertoireMove.repertoireId, activeRep.id))
		);

	// Scope-filter: only cards whose fromFen is reachable from start position.
	const scopedCards = scopeCards(activeRep, moves, allCards);

	const totalCards = scopedCards.length;

	// ── To do (due counts per module) ───────────────────────────────────
	// The drill count comes from the cards already loaded above, the other two
	// from the same functions the top-menu badges use (computed earlier).
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
				eq(drillSession.repertoireId, activeRep.id),
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
