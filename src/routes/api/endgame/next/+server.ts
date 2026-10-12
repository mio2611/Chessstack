// GET /api/endgame/next — returns the next endgame card to drill.
//
// Priority order:
//   1. Any endgame_card already due for this user (due <= now), earliest due first.
//   2. Otherwise, the next never-graded position (never presented, or presented
//      but abandoned before grading, i.e. card row with due NULL), in the source catalogue's own
//      fixed category order (Basic, Pawn, Bishop, Knight, Knight-Bishop,
//      Rook-Pawn, Rook-Pieces, Queen — see scripts/endgame-import.py), then
//      subcategory, then fen — not alphabetical, which would scramble that
//      order. No adaptive/rating-based selection (dropped by design).
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
import { eq, and, lte, isNotNull, notInArray, sql } from 'drizzle-orm';

// Matches the category order in the source catalogue (see
// scripts/endgame-import.py's SOURCE_URL categories), not alphabetical.
const CATEGORY_ORDER = [
	'Basic',
	'Pawn',
	'Bishop',
	'Knight',
	'Knight-Bishop',
	'Rook-Pawn',
	'Rook-Pieces',
	'Queen'
];

function modeForCategory(category: string): 'theory' | 'practice' {
	return category === 'Basic' ? 'theory' : 'practice';
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	// 1. Any card already due.
	const [dueRow] = await db
		.select({ card: endgameCard, position: endgamePosition })
		.from(endgameCard)
		.innerJoin(endgamePosition, eq(endgameCard.fen, endgamePosition.fen))
		.where(and(eq(endgameCard.userId, userId), lte(endgameCard.due, new Date())))
		.orderBy(endgameCard.due)
		.limit(1);

	if (dueRow) {
		return json({
			card: dueRow.card,
			position: dueRow.position,
			mode: modeForCategory(dueRow.position.category)
		});
	}

	// 2. Next never-graded position, in fixed catalogue order. A card whose due
	// is NULL was created on presentation but never graded (session abandoned):
	// it is not "seen", otherwise it would be orphaned forever (step 1 skips
	// NULL due, and the badge ignores it by design).
	const seenFensSubquery = db
		.select({ fen: endgameCard.fen })
		.from(endgameCard)
		.where(and(eq(endgameCard.userId, userId), isNotNull(endgameCard.due)));

	const categoryOrderCase = sql`CASE ${endgamePosition.category} ${sql.join(
		CATEGORY_ORDER.map((c, i) => sql`WHEN ${c} THEN ${i}`),
		sql` `
	)} ELSE ${CATEGORY_ORDER.length} END`;

	const [nextPosition] = await db
		.select()
		.from(endgamePosition)
		.where(notInArray(endgamePosition.fen, seenFensSubquery))
		.orderBy(categoryOrderCase, endgamePosition.subcategory, endgamePosition.fen)
		.limit(1);

	if (!nextPosition) {
		// Every position has been seen at least once, and none are due yet.
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
