// POST /api/anti-gaffe/ensure-reviewed-game
//
// Creates a minimal reviewed_game row for a pasted game that has neither
// an imported_game_id nor an existing reviewed_game_id yet — purely so the
// anti-gaffe scan has somewhere valid to attach candidates to (see
// anti_gaffe_candidate's "exactly one source" constraint).
//
// Deliberately NOT /api/review/save: that endpoint's semantics are about
// saving a *deviation* review specifically (requires a repertoire, updates
// imported_game.status to 'reviewed', records deviationFen). None of that
// applies here — this is just "make this pasted game exist as a row",
// independent of whether a repertoire was involved at all. repertoireId is
// optional and may be null (see migration 0034).

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { repertoire, reviewedGame } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { pgn, repertoireId = null } = body;

	if (!pgn || typeof pgn !== 'string') throw error(400, 'pgn is required');
	if (repertoireId !== null && typeof repertoireId !== 'number') {
		throw error(400, 'repertoireId must be a number or null');
	}

	if (repertoireId !== null) {
		const [rep] = await db
			.select({ id: repertoire.id })
			.from(repertoire)
			.where(and(eq(repertoire.id, repertoireId), eq(repertoire.userId, userId)));
		if (!rep) throw error(404, 'Repertoire not found');
	}

	const [saved] = await db
		.insert(reviewedGame)
		.values({
			userId,
			repertoireId,
			pgn,
			source: 'MANUAL',
			lichessGameId: null,
			deviationFen: null,
			playedAt: null,
			reviewedAt: new Date(),
			notes: null
		})
		.returning();

	return json({ id: saved.id });
};
