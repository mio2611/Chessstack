// POST /api/endgame/grade — apply a rating to an endgame card and update its
// SR state. Mirrors api/drill/grade exactly, against endgame_card /
// endgame_review_log instead of user_repertoire_move / review_log.
//
// Unlike the opening Drill, the rating here is computed by the client from
// objective play data (WDL preservation, move count vs DTZ in Practice mode;
// retry count in Theory mode) — not chosen by the user. The server does not
// recompute or verify that grading logic; it trusts the rating the client
// sends, same as api/drill/grade trusts the button the user clicked. The
// `source` field records which mode produced the rating, for later analysis.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { endgameCard, endgameReviewLog } from '$lib/db/schema';
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
	const { cardId, rating, mode } = body;

	if (typeof cardId !== 'number') throw error(400, 'cardId must be a number');
	if (![Rating.Again, Rating.Good, Rating.Easy].includes(rating)) {
		throw error(400, 'rating must be 1 (Forgot), 3 (Unsure), or 4 (Easy)');
	}
	if (mode !== 'practice' && mode !== 'theory') {
		throw error(400, "mode must be 'practice' or 'theory'");
	}
	const source = mode === 'theory' ? 'ENDGAME_THEORY' : 'ENDGAME_PRACTICE';

	const [cardRows, fsrsConfig] = await Promise.all([
		db
			.select()
			.from(endgameCard)
			.where(and(eq(endgameCard.id, cardId), eq(endgameCard.userId, userId))),
		loadFsrsConfig(userId)
	]);

	const card = cardRows[0];
	if (!card) throw error(404, 'Card not found');

	const now = new Date();
	const updated = gradeCard(card, rating as Rating, now, fsrsConfig);
	const logEntry = buildReviewLogEntry(card, rating as Rating, updated, now, source, fsrsConfig);

	await db.transaction(async (tx) => {
		await tx.update(endgameCard).set(updated).where(eq(endgameCard.id, cardId));
		await tx.insert(endgameReviewLog).values({ userId, cardId, ...logEntry });
	});

	return json({ updated: true, due: updated.due });
};
