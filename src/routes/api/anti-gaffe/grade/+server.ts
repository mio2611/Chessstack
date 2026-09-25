// POST /api/anti-gaffe/grade — apply a rating to an anti-gaffe card and
// update its SR state. Mirrors api/drill/grade exactly, against
// anti_gaffe_card / anti_gaffe_review_log instead of
// user_repertoire_move / review_log.
//
// Self-reported rating (Again/Good/Easy), same as the opening Drill — not
// computed from objective play data, unlike endgame/grade (which has a
// tablebase to check against). There's nothing equivalent here: the user
// looks at the position, tries to recall the move, reveals it, and grades
// their own recall.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { antiGaffeCard, antiGaffeReviewLog } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { gradeCard, buildReviewLogEntry, Rating } from '$lib/fsrs';
import { loadFsrsConfig } from '$lib/server/fsrs-config';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { cardId, rating } = body;

	if (typeof cardId !== 'number') throw error(400, 'cardId must be a number');
	if (![Rating.Again, Rating.Good, Rating.Easy].includes(rating)) {
		throw error(400, 'rating must be 1 (Forgot), 3 (Unsure), or 4 (Easy)');
	}

	const [cardRows, fsrsConfig] = await Promise.all([
		db
			.select()
			.from(antiGaffeCard)
			.where(and(eq(antiGaffeCard.id, cardId), eq(antiGaffeCard.userId, userId))),
		loadFsrsConfig(userId)
	]);

	const card = cardRows[0];
	if (!card) throw error(404, 'Card not found');

	const now = new Date();
	const updated = gradeCard(card, rating as Rating, now, fsrsConfig);
	const logEntry = buildReviewLogEntry(
		card,
		rating as Rating,
		updated,
		now,
		'ANTI_GAFFE',
		fsrsConfig
	);

	await db.transaction(async (tx) => {
		await tx.update(antiGaffeCard).set(updated).where(eq(antiGaffeCard.id, cardId));
		await tx.insert(antiGaffeReviewLog).values({ userId, cardId, ...logEntry });
	});

	return json({ updated: true, due: updated.due });
};
