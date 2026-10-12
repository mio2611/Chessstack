// GET /api/nav-counts?repertoireId=<id> — due counts for the top-menu badges.
//
// Returns { drill, endgame, antiGaffe }. The drill count is scoped to the
// repertoire passed in the query (the layout sends the active one) and is
// computed with the same scope filter as /drill. The repertoire is looked up
// with the user's id, so another user's repertoire id yields drill = 0.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { repertoire } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getDueCounts } from '$lib/server/due-counts';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const repertoireId = parseInt(url.searchParams.get('repertoireId') ?? '', 10);
	let rep = null;
	if (Number.isInteger(repertoireId)) {
		[rep] = await db
			.select()
			.from(repertoire)
			.where(and(eq(repertoire.id, repertoireId), eq(repertoire.userId, userId)));
	}

	const counts = await getDueCounts(userId, rep ?? null);
	return json(counts, { headers: { 'Cache-Control': 'no-store' } });
};
