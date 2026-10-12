// GET /api/endgame/stats — per category/subcategory counts (total, done, due)
// for the current user. Feeds the filter panel on /endgame.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEndgameStats } from '$lib/server/endgame-stats';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	return json({ rows: await getEndgameStats(locals.user.id) });
};
