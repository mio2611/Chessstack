// GET /api/nav-counts?repertoireId=<id> — due counts for the top-menu badges.
//
// Returns { drill, endgame, antiGaffe }. The drill count is scoped to the
// repertoire passed in the query (the layout sends the active one) and is
// computed with the same scope filter as /drill. The repertoire is looked up
// with the user's id, so another user's repertoire id yields drill = 0.
//
// It also refreshes today's card snapshot in the background (see below).

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { repertoire } from '$lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getDueCounts } from '$lib/server/due-counts';
import { scheduleCardSnapshot } from '$lib/server/card-snapshots';
import { resolveTimeZone } from '$lib/local-days';

export const GET: RequestHandler = async ({ locals, url, cookies }) => {
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

	// Side effect on purpose: this endpoint runs after every grade and on
	// navigation, which is the cheapest place to keep today's /stats snapshot
	// of total and struggling cards current. Fire-and-forget, never blocks.
	if (rep) scheduleCardSnapshot(userId, rep, resolveTimeZone(cookies.get('tz')));

	return json(counts, { headers: { 'Cache-Control': 'no-store' } });
};
