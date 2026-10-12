// Counts of "things to do" per spaced-repetition module.
//
// One source of truth for two consumers that must never disagree:
//   - GET /api/nav-counts  (badges in the top menu)
//   - the dashboard "To do" widget
//
// A card is "to do" only when it is due (due <= now). Never-seen endgame
// positions are deliberately NOT counted: /api/endgame/next always has one
// to offer until all positions have been seen, so counting them would keep
// the badge lit permanently.

import { db } from '$lib/db';
import {
	userMove,
	userRepertoireMove,
	endgameCard,
	antiGaffeCard,
	repertoire
} from '$lib/db/schema';
import { and, count, eq, lte } from 'drizzle-orm';
import { fenKey } from '$lib/gaps';
import { getEffectiveStartFens, buildInScopeFens } from '$lib/repertoire';

export interface DueCounts {
	drill: number;
	endgame: number;
	antiGaffe: number;
}

type RepertoireRow = typeof repertoire.$inferSelect;
type MoveRow = typeof userMove.$inferSelect;

/**
 * Keeps only the cards whose fromFen is reachable from the repertoire's
 * effective start position — the same lead-in filter /drill applies, so a
 * count built on it matches what a drill session will actually offer.
 */
export function scopeCards<C extends { fromFen: string }>(
	rep: RepertoireRow,
	moves: MoveRow[],
	cards: C[]
): C[] {
	const startFens = getEffectiveStartFens(
		rep.startFen ?? null,
		moves,
		rep.color as 'WHITE' | 'BLACK'
	);
	const inScope = buildInScopeFens(startFens, moves);
	return cards.filter((c) => inScope.has(fenKey(c.fromFen)));
}

/** A card is due when it has a due date that is not in the future. */
export function isDue(card: { due: Date | null }, now: Date): boolean {
	return card.due !== null && card.due <= now;
}

/** Due drill cards of one repertoire, scope-filtered exactly like /drill. */
export async function countDueDrill(userId: number, rep: RepertoireRow): Promise<number> {
	const now = new Date();
	const [moves, dueCards] = await Promise.all([
		db
			.select()
			.from(userMove)
			.where(and(eq(userMove.userId, userId), eq(userMove.repertoireId, rep.id))),
		db
			.select()
			.from(userRepertoireMove)
			.where(
				and(
					eq(userRepertoireMove.userId, userId),
					eq(userRepertoireMove.repertoireId, rep.id),
					lte(userRepertoireMove.due, now)
				)
			)
	]);
	return scopeCards(rep, moves, dueCards).length;
}

export async function countDueEndgame(userId: number): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(endgameCard)
		.where(and(eq(endgameCard.userId, userId), lte(endgameCard.due, new Date())));
	return Number(row.n);
}

export async function countDueAntiGaffe(userId: number): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(antiGaffeCard)
		.where(and(eq(antiGaffeCard.userId, userId), lte(antiGaffeCard.due, new Date())));
	return Number(row.n);
}

/** All three counts. `rep` null (no active repertoire) yields 0 for drill. */
export async function getDueCounts(userId: number, rep: RepertoireRow | null): Promise<DueCounts> {
	const [drill, endgame, antiGaffe] = await Promise.all([
		rep ? countDueDrill(userId, rep) : Promise.resolve(0),
		countDueEndgame(userId),
		countDueAntiGaffe(userId)
	]);
	return { drill, endgame, antiGaffe };
}
