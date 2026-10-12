// GET /api/endgame/next — returns the next endgame card to drill.
//
// Query parameters (both optional):
//   exclude  JSON array of [category, subcategory] pairs the user has
//            unticked in the filter panel. They are never offered as NEW
//            positions.
//   reviews  "selection" to apply the same exclusion to due reviews. Absent,
//            due cards from every category are served as before, so
//            unticking a category never strands reviews.
//
// Priority order:
//   1. Any endgame_card already due for this user (due <= now), earliest due
//      first (restricted to the selection only when reviews=selection).
//   2. Otherwise, a never-graded position (never presented, or presented
//      but abandoned before grading, i.e. card row with due NULL) from the
//      non-excluded subcategories, ALTERNATING: the category with the fewest
//      positions done so far goes first (ties: catalogue order), then within
//      it the subcategory with the fewest done (ties: alphabetical), then the
//      first unseen position by fen. No adaptive/rating-based selection
//      (dropped by design).
//
// A never-seen position gets its endgame_card row created here, lazily, the
// first time it's presented — not at import time, since a card only exists
// once a user is actually tracking review state for it.
//
// Mode is derived from category, not stored: 'theory' for "Basic" (canonical
// checkmate technique, exact optimal line required), 'practice' otherwise
// (goal must be preserved, move count not enforced).

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { endgameCard, endgamePosition } from '$lib/db/schema';
import { eq, and, lte, isNotNull, notInArray, not, or } from 'drizzle-orm';
import {
	categoryRank,
	getEndgameStats,
	pairKey,
	parseExcluded,
	type ExcludedPair
} from '$lib/server/endgame-stats';

function modeForCategory(category: string): 'theory' | 'practice' {
	return category === 'Basic' ? 'theory' : 'practice';
}

function notExcludedCondition(excluded: ExcludedPair[]) {
	if (excluded.length === 0) return undefined;
	return not(
		or(
			...excluded.map(([c, s]) =>
				and(eq(endgamePosition.category, c), eq(endgamePosition.subcategory, s))
			)
		)!
	);
}

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const excluded = parseExcluded(url.searchParams.get('exclude'));
	if (excluded === null) throw error(400, 'Invalid exclude parameter');
	const limitReviews = url.searchParams.get('reviews') === 'selection';

	// 1. Any card already due.
	const [dueRow] = await db
		.select({ card: endgameCard, position: endgamePosition })
		.from(endgameCard)
		.innerJoin(endgamePosition, eq(endgameCard.fen, endgamePosition.fen))
		.where(
			and(
				eq(endgameCard.userId, userId),
				lte(endgameCard.due, new Date()),
				limitReviews ? notExcludedCondition(excluded) : undefined
			)
		)
		.orderBy(endgameCard.due)
		.limit(1);

	if (dueRow) {
		return json({
			card: dueRow.card,
			position: dueRow.position,
			mode: modeForCategory(dueRow.position.category)
		});
	}

	// 2. A never-graded position, alternating across the selected categories.
	// A card whose due is NULL was created on presentation but never graded
	// (session abandoned): it is not "seen", otherwise it would be orphaned
	// forever (step 1 skips NULL due, and the badge ignores it by design).
	const excludedKeys = new Set(excluded.map(([c, s]) => pairKey(c, s)));
	const stats = await getEndgameStats(userId);
	const candidates = stats.filter(
		(r) => !excludedKeys.has(pairKey(r.category, r.subcategory)) && r.total - r.done > 0
	);

	if (candidates.length === 0) {
		// Nothing due, and no new position in the current selection.
		return json(null);
	}

	// Category with the fewest positions done (all subcategories of that
	// category count, selected or not, so the balance reflects real practice).
	const doneByCategory: Record<string, number> = {};
	for (const r of stats) doneByCategory[r.category] = (doneByCategory[r.category] ?? 0) + r.done;

	const chosenCategory = [...new Set(candidates.map((r) => r.category))].sort(
		(a, b) => doneByCategory[a] - doneByCategory[b] || categoryRank(a) - categoryRank(b)
	)[0];

	const chosenSub = candidates
		.filter((r) => r.category === chosenCategory)
		.sort((a, b) => a.done - b.done || a.subcategory.localeCompare(b.subcategory))[0];

	const seenFensSubquery = db
		.select({ fen: endgameCard.fen })
		.from(endgameCard)
		.where(and(eq(endgameCard.userId, userId), isNotNull(endgameCard.due)));

	const [nextPosition] = await db
		.select()
		.from(endgamePosition)
		.where(
			and(
				eq(endgamePosition.category, chosenSub.category),
				eq(endgamePosition.subcategory, chosenSub.subcategory),
				notInArray(endgamePosition.fen, seenFensSubquery)
			)
		)
		.orderBy(endgamePosition.fen)
		.limit(1);

	if (!nextPosition) {
		// Counts and rows disagreed (concurrent grading between the two queries).
		return json(null);
	}

	// Create the card, lazily, on first presentation. A concurrent request
	// (e.g. double-click) could race here — ON CONFLICT DO NOTHING plus a
	// re-select handles that without erroring.
	await db.insert(endgameCard).values({ userId, fen: nextPosition.fen }).onConflictDoNothing();

	const [card] = await db
		.select()
		.from(endgameCard)
		.where(and(eq(endgameCard.userId, userId), eq(endgameCard.fen, nextPosition.fen)));

	return json({
		card,
		position: nextPosition,
		mode: modeForCategory(nextPosition.category)
	});
};
