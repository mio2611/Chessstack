// POST /api/anti-gaffe/scan-complete
//
// Marks anti_gaffe_scanned_at on the given game — called once by the
// client scan loop after it has finished walking the whole game, whether
// or not any candidates were found. Deliberately independent of
// imported_game.status, which tracks the deviation workflow only (see
// schema.ts's comment on that column).

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { importedGame, reviewedGame } from '$lib/db/schema';
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
	const { gameSource, gameId } = body;

	if (gameSource !== 'imported' && gameSource !== 'reviewed') {
		throw error(400, 'gameSource must be "imported" or "reviewed"');
	}
	if (typeof gameId !== 'number') throw error(400, 'gameId must be a number');

	const table = gameSource === 'imported' ? importedGame : reviewedGame;

	const [updated] = await db
		.update(table)
		.set({ antiGaffeScannedAt: new Date() })
		.where(and(eq(table.id, gameId), eq(table.userId, userId)))
		.returning();

	if (!updated) throw error(404, 'Game not found');

	return json({ antiGaffeScannedAt: updated.antiGaffeScannedAt });
};
