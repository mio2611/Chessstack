// GET /api/anti-gaffe/next — returns the next anti-gaffe card due for this
// user, or null if none is due.
//
// Unlike endgame/next, there is no "never-seen position" branch: anti-gaffe
// has no shared seed catalogue (see anti_gaffe_card's own comment in
// schema.ts) — every card already exists the moment a candidate is
// accepted, so due-or-nothing is the whole selection.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { antiGaffeCard } from '$lib/db/schema';
import { eq, and, lte } from 'drizzle-orm';
import { intervalLabels } from '$lib/fsrs';
import { loadFsrsConfig } from '$lib/server/fsrs-config';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const [dueCard] = await db
		.select()
		.from(antiGaffeCard)
		.where(and(eq(antiGaffeCard.userId, userId), lte(antiGaffeCard.due, new Date())))
		.orderBy(antiGaffeCard.due)
		.limit(1);

	if (!dueCard) return json(null);

	const now = new Date();
	const fsrsConfig = await loadFsrsConfig(userId);

	return json({ ...dueCard, intervalLabels: intervalLabels(dueCard, now, fsrsConfig) });
};
