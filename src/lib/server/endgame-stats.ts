// Shared helpers for the endgame module's category filter.
//
//   - getEndgameStats(): per (category, subcategory) counts for one user,
//     used by GET /api/endgame/stats (the filter panel) and by
//     GET /api/endgame/next (the alternating selection of new positions).
//   - parseExcluded(): validates the `exclude` query parameter.
//
// "Done" means a card exists with due NOT NULL, i.e. graded at least once.
// This is the same definition /api/endgame/next uses to decide what is
// still "new", so the panel's New count always matches what can be offered.

import { db } from '$lib/db';
import { endgameCard, endgamePosition } from '$lib/db/schema';
import { and, count, eq, lte, sql } from 'drizzle-orm';

// Matches the category order in the source catalogue (see
// scripts/endgame-import.py), not alphabetical. Used for display order and
// as the tie-breaker when the alternating selection has no other signal.
export const CATEGORY_ORDER = [
	'Basic',
	'Pawn',
	'Bishop',
	'Knight',
	'Knight-Bishop',
	'Rook-Pawn',
	'Rook-Pieces',
	'Queen'
];

export function categoryRank(category: string): number {
	const i = CATEGORY_ORDER.indexOf(category);
	return i === -1 ? CATEGORY_ORDER.length : i;
}

export interface EndgameStatRow {
	category: string;
	subcategory: string;
	total: number;
	done: number;
	due: number;
}

export async function getEndgameStats(userId: number): Promise<EndgameStatRow[]> {
	const rows = await db
		.select({
			category: endgamePosition.category,
			subcategory: endgamePosition.subcategory,
			total: count(),
			done: count(endgameCard.due),
			due: sql<number>`count(*) filter (where ${lte(endgameCard.due, new Date())})`.mapWith(Number)
		})
		.from(endgamePosition)
		.leftJoin(
			endgameCard,
			and(eq(endgameCard.fen, endgamePosition.fen), eq(endgameCard.userId, userId))
		)
		.groupBy(endgamePosition.category, endgamePosition.subcategory);

	return rows.sort(
		(a, b) =>
			categoryRank(a.category) - categoryRank(b.category) ||
			a.subcategory.localeCompare(b.subcategory)
	);
}

export type ExcludedPair = [string, string];

const MAX_EXCLUDED = 500;

/**
 * Parses the `exclude` query parameter: a JSON array of
 * [category, subcategory] pairs. Returns null when the value is malformed
 * (the caller answers 400); a missing parameter means "nothing excluded".
 */
export function parseExcluded(raw: string | null): ExcludedPair[] | null {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_EXCLUDED) return null;
	const out: ExcludedPair[] = [];
	for (const item of parsed) {
		if (
			!Array.isArray(item) ||
			item.length !== 2 ||
			typeof item[0] !== 'string' ||
			typeof item[1] !== 'string'
		) {
			return null;
		}
		out.push([item[0], item[1]]);
	}
	return out;
}

export function pairKey(category: string, subcategory: string): string {
	return JSON.stringify([category, subcategory]);
}
