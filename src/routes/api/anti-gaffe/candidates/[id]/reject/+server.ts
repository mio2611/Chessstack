// POST /api/anti-gaffe/candidates/[id]/reject
//
// Rejects a pending candidate — no card involved, just marks it so it
// stops showing up in the Anti-gaffe tab's pending list.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { antiGaffeCandidate } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const candidateId = parseInt(params.id ?? '');
	if (isNaN(candidateId)) throw error(400, 'Invalid candidate id');

	const [candidate] = await db
		.select()
		.from(antiGaffeCandidate)
		.where(and(eq(antiGaffeCandidate.id, candidateId), eq(antiGaffeCandidate.userId, userId)));

	if (!candidate) throw error(404, 'Candidate not found');
	if (candidate.status !== 'pending') {
		throw error(409, `Candidate already ${candidate.status}`);
	}

	const [updated] = await db
		.update(antiGaffeCandidate)
		.set({ status: 'rejected', reviewedAt: new Date() })
		.where(eq(antiGaffeCandidate.id, candidateId))
		.returning();

	return json(updated);
};
